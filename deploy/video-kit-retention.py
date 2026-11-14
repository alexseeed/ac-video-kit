#!/usr/bin/env python3
"""Loescht abgelaufene Video-Kit-Videos bei Mux und markiert sie als expired.

Laeuft taeglich auf dem VPS: Videos aelter als --days, die noch nicht
expired sind und ein Mux-Asset oder ein GIF haben, werden bei Mux geloescht
(DELETE pro Asset aus der DB, es wird nie bei Mux gelistet) und in der DB auf
expired gesetzt. Fremde Assets im selben Mux-Konto bleiben unangetastet.
Nur Standardbibliothek. Zugangsdaten werden nie ausgegeben oder geloggt.
"""
import argparse
import base64
import io
import json
import os
import re
import sqlite3
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from unittest import mock

DEFAULT_DB = "/opt/video-kit/data/ac-video.sqlite"
DEFAULT_GIF_DIR = "/opt/video-kit/data/gifs"
MUX_BASE_URL = "https://api.mux.com"
SHORT_ID = re.compile(r"^[A-Za-z0-9]{12}$")
REMOVE_FIELDS = ("playbackId", "muxAssetId", "videoFileUrl")


def _iso(ms):
    """Millisekunden als UTC-ISO wie der Server (toISOString)."""
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


def mux_delete(asset_id, token_id, token_secret, base_url=MUX_BASE_URL):
    """DELETE eines Assets; liefert den HTTP-Status. Nennt nie das Geheimnis."""
    credentials = base64.b64encode(f"{token_id}:{token_secret}".encode("utf-8")).decode("ascii")
    url = f"{base_url.rstrip('/')}/video/v1/assets/{urllib.parse.quote(asset_id, safe='')}"
    request = urllib.request.Request(url, method="DELETE", headers={"Authorization": f"Basic {credentials}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception as error:
        raise RuntimeError(f"DELETE Asset scheiterte: {type(error).__name__}") from None


def due_videos(conn, cutoff_ms, gif_dir, limit):
    """(Faellige Videos, aelteste zuerst; defekte Zeilen). Nur mit Asset oder GIF."""
    rows = conn.execute("SELECT id, short_id, campaign_id, data FROM videos WHERE status != 'expired' AND created_ms < ?"
                        " ORDER BY created_ms ASC, id ASC", (cutoff_ms,)).fetchall()
    due, broken = [], 0
    for video_id, short_id, campaign_id, data_json in rows:
        try:
            data = json.loads(data_json)
            assert isinstance(data, dict)
        except (ValueError, AssertionError):
            broken += 1
            continue
        asset = data.get("muxAssetId")
        gif = os.path.join(gif_dir, f"{short_id}.gif") if isinstance(short_id, str) and SHORT_ID.match(short_id) else None
        if (isinstance(asset, str) and asset) or (gif is not None and os.path.exists(gif)):
            due.append({"id": video_id, "short_id": short_id, "campaign_id": campaign_id,
                        "asset": asset if isinstance(asset, str) and asset else None, "gif": gif})
            if len(due) >= limit:
                break
    return due, broken


def expire_video(conn, video_id, expired_at):
    """Status expired, Mux-Felder raus, Lease leer; liest das JSON frisch in einer Transaktion."""
    with conn:
        row = conn.execute("SELECT data FROM videos WHERE id=?", (video_id,)).fetchone()
        data = json.loads(row[0])
        for field in REMOVE_FIELDS:
            data.pop(field, None)
        data["status"] = "expired"
        data["expiredAt"] = expired_at
        conn.execute("UPDATE videos SET status='expired', data=?, lease_until=NULL, lease_token=NULL WHERE id=?",
                     (json.dumps(data, ensure_ascii=False), video_id))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Abgelaufene Video-Kit-Videos bei Mux loeschen und als expired markieren.")
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--gif-dir", default=DEFAULT_GIF_DIR)
    parser.add_argument("--days", type=float, default=90.0)
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--dry-run", action="store_true", help="Nur zaehlen, nichts loeschen oder aendern")
    parser.add_argument("--self-test", action="store_true", help="Interne Pruefungen ohne Netzzugriffe")
    args = parser.parse_args(argv)
    if args.self_test:
        return 0 if self_test() else 1
    if args.days <= 0:
        print("video-kit-retention: --days muss groesser als 0 sein", file=sys.stderr)
        return 1
    if args.limit < 1:
        print("video-kit-retention: --limit muss mindestens 1 sein", file=sys.stderr)
        return 1
    token_id = os.environ.get("MUX_TOKEN_ID", "")
    token_secret = os.environ.get("MUX_TOKEN_SECRET", "")
    if not args.dry_run and (not token_id or not token_secret):
        missing = " und ".join(name for name, value in (("MUX_TOKEN_ID", token_id), ("MUX_TOKEN_SECRET", token_secret)) if not value)
        print(f"video-kit-retention: {missing} fehlt", file=sys.stderr)
        return 1
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    cutoff_ms = now_ms - int(args.days * 86400_000)
    try:
        conn = sqlite3.connect(args.db, timeout=30.0)
    except Exception:
        print(f"video-kit-retention: Datenbank {args.db} nicht lesbar", file=sys.stderr)
        return 1
    try:
        due, fehler = due_videos(conn, cutoff_ms, args.gif_dir, args.limit)
        line = {"zeit": _iso(now_ms), "cutoff": _iso(cutoff_ms), "geprueft": len(due)}
        if args.dry_run:
            durations = {row[0]: row[1] for row in conn.execute("SELECT id, duration_sec FROM campaigns")}
            minuten = round(sum(float(durations.get(video["campaign_id"], 0) or 0) for video in due) / 60, 1)
            line.update({"abgelaufen": 0, "mux_geloescht": 0, "mux_404": 0, "gif_geloescht": 0, "fehler": fehler,
                         "minuten": minuten, "dry_run": True})
            print(json.dumps(line, ensure_ascii=False))
            return 1 if fehler else 0
        mux_geloescht = mux_404 = gif_geloescht = abgelaufen = 0
        for video in due:
            try:
                if video["asset"]:
                    status = mux_delete(video["asset"], token_id, token_secret)
                    if status == 204:
                        mux_geloescht += 1
                    elif status == 404:
                        mux_404 += 1
                    else:
                        raise RuntimeError(f"Mux-Status {status}")
                if video["gif"] is not None:
                    try:
                        os.unlink(video["gif"])
                        gif_geloescht += 1
                    except FileNotFoundError:
                        pass
                expire_video(conn, video["id"], _iso(now_ms))
                abgelaufen += 1
            except Exception as error:
                fehler += 1
                print(f"video-kit-retention: {video['short_id']}: {type(error).__name__} {error}", file=sys.stderr)
        line.update({"abgelaufen": abgelaufen, "mux_geloescht": mux_geloescht, "mux_404": mux_404,
                     "gif_geloescht": gif_geloescht, "fehler": fehler})
        print(json.dumps(line, ensure_ascii=False))
        return 1 if fehler else 0
    finally:
        conn.close()


def self_test():
    """Pruefungen mit temporaerer DB und gefaelschtem Mux; keine Netzzugriffe."""
    passed = [0]

    def check(name, condition):
        if not condition:
            print(f"SELBSTTEST FEHLGESCHLAGEN: {name}", file=sys.stderr)
        else:
            passed[0] += 1
        return condition

    ok = True
    with tempfile.TemporaryDirectory(prefix="aufbewahrung-") as tmp:
        db = os.path.join(tmp, "ac-video.sqlite")
        gif_dir = os.path.join(tmp, "gifs")
        os.mkdir(gif_dir)
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        day = 86400_000
        conn = sqlite3.connect(db)
        conn.execute("CREATE TABLE campaigns (id TEXT PRIMARY KEY, data TEXT NOT NULL, duration_sec REAL NOT NULL, created_at TEXT NOT NULL)")
        conn.execute("CREATE TABLE videos (id TEXT PRIMARY KEY, short_id TEXT UNIQUE NOT NULL, campaign_id TEXT NOT NULL, data TEXT NOT NULL,"
                     " status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, lease_token TEXT, created_ms INTEGER NOT NULL)")
        for campaign_id, duration in (("camp-a", 12), ("camp-b", 60), ("camp-c", 30)):
            conn.execute("INSERT INTO campaigns(id,data,duration_sec,created_at) VALUES(?,?,?,?)",
                         (campaign_id, json.dumps({"id": campaign_id}), duration, "2026-01-01T00:00:00.000Z"))

        def add(video_id, short_id, campaign_id, age_days, status, asset=None, lease=False):
            data = {"id": video_id, "shortId": short_id, "campaignId": campaign_id, "status": status,
                    "title": "Fixture", "createdAt": "2026-01-01T00:00:00.000Z"}
            if asset:
                data.update({"muxAssetId": asset, "playbackId": f"play-{asset}",
                             "videoFileUrl": f"https://stream.mux.com/play-{asset}/highest.mp4"})
            if status == "expired":
                data["expiredAt"] = "2026-01-01T00:00:00.000Z"
            conn.execute("INSERT INTO videos(id,short_id,campaign_id,data,status,lease_until,lease_token,created_ms) VALUES(?,?,?,?,?,?,?,?)",
                         (video_id, short_id, campaign_id, json.dumps(data), status,
                          123 if lease else None, "lease-fixture" if lease else None, now_ms - age_days * day))

        add("v-ok", "okokokokokok", "camp-a", 100, "rendered", "asset-ok", lease=True)
        add("v-gone", "gonegonegone", "camp-a", 95, "rendered", "asset-gone")
        add("v-plain", "plainplainpl", "camp-b", 93, "failed")
        add("v-boom", "boomboomboom", "camp-b", 92, "rendered", "asset-boom")
        add("v-young", "youngyoung00", "camp-b", 10, "rendered", "asset-young")
        add("v-expired", "expiredexp00", "camp-c", 120, "expired", "asset-old")
        add("v-nothing", "nothingnoth0", "camp-b", 100, "failed")
        conn.commit()

        def dump():
            return conn.execute("SELECT id, short_id, campaign_id, data, status, lease_until, lease_token, created_ms FROM videos ORDER BY id").fetchall()

        def gifs():
            return sorted(os.listdir(gif_dir))

        for short_id in ("okokokokokok", "plainplainpl", "youngyoung00"):
            with open(os.path.join(gif_dir, f"{short_id}.gif"), "wb") as handle:
                handle.write(b"GIF89a-fixture")
        calls = []
        secret = "aufbewahrung-fixture-geheimnis"

        def fake_delete(asset_id, token_id, token_secret, base_url=MUX_BASE_URL):
            calls.append(asset_id)
            assert (token_id, token_secret) == ("fixture-id", secret), "Zugang muss durchgereicht werden"
            return {"asset-ok": 204, "asset-gone": 404, "asset-boom": 500}[asset_id]

        # Trockenlauf zuerst: ohne Zugangsdaten, aendert nichts, ruft Mux nie auf.
        before_db, before_gifs = dump(), gifs()
        with mock.patch.dict(os.environ, {}, clear=True):
            out = io.StringIO()
            with redirect_stdout(out):
                code = main(["--db", db, "--gif-dir", gif_dir, "--dry-run"])
        line = json.loads(out.getvalue().strip())
        ok &= check("Trockenlauf braucht keine Zugangsdaten", code == 0)
        ok &= check("Trockenlauf nennt Faellige und Minuten",
                    line["geprueft"] == 4 and line["minuten"] == 2.4 and line["abgelaufen"] == 0
                    and line["fehler"] == 0 and line.get("dry_run") is True)
        ok &= check("Trockenlauf aendert nichts", dump() == before_db and gifs() == before_gifs)
        ok &= check("Trockenlauf ruft Mux nie auf", calls == [])

        # Echter Lauf: nur Faellige werden geloescht und auf expired gesetzt.
        boom_before = [row for row in dump() if row[0] == "v-boom"]
        with mock.patch.dict(os.environ, {"MUX_TOKEN_ID": "fixture-id", "MUX_TOKEN_SECRET": secret}):
            with mock.patch(__name__ + ".mux_delete", side_effect=fake_delete):
                out = io.StringIO()
                with redirect_stdout(out), redirect_stderr(io.StringIO()):
                    code = main(["--db", db, "--gif-dir", gif_dir])
        line = json.loads(out.getvalue().strip())
        ok &= check("Lauf mit 500er liefert Exit 1", code == 1)
        ok &= check("Zaehler stimmen", (line["geprueft"], line["abgelaufen"], line["mux_geloescht"], line["mux_404"],
                                        line["gif_geloescht"], line["fehler"]) == (4, 3, 1, 1, 2, 1))
        ok &= check("Ausgabe-Schema exakt", set(line) == {"zeit", "cutoff", "geprueft", "abgelaufen", "mux_geloescht",
                                                          "mux_404", "gif_geloescht", "fehler"})
        ok &= check("Aelteste zuerst", calls == ["asset-ok", "asset-gone", "asset-boom"])
        ok &= check("Nur DB-Assets geloescht", set(calls) <= {"asset-ok", "asset-gone", "asset-boom"}
                    and "asset-young" not in calls and "asset-old" not in calls)
        ok &= check("Geheimnis nie in der Ausgabe", secret not in out.getvalue())
        rows = {row[0]: row for row in dump()}
        expired_rows = [rows[video_id] for video_id in ("v-ok", "v-gone", "v-plain")]
        ok &= check("Faellige sind expired ohne Lease",
                    all(row[4] == "expired" and row[5] is None and row[6] is None for row in expired_rows))
        datas = [json.loads(row[3]) for row in expired_rows]
        ok &= check("Mux-Felder entfernt, expiredAt gesetzt",
                    all(all(field not in data for field in ("playbackId", "muxAssetId", "videoFileUrl"))
                        and data["status"] == "expired" and isinstance(data.get("expiredAt"), str) for data in datas))
        ok &= check("500er-Video bleibt unveraendert", [row for row in dump() if row[0] == "v-boom"] == boom_before)
        ok &= check("Junges, altes und leeres Video bleiben unveraendert",
                    all(rows[video_id][4] == status for video_id, status in
                        (("v-young", "rendered"), ("v-expired", "expired"), ("v-nothing", "failed"))))
        ok &= check("GIFs der Faelligen weg, junges GIF bleibt", gifs() == ["youngyoung00.gif"])

        # Fehlende Zugangsdaten nennen beide Namen.
        with mock.patch.dict(os.environ, {}, clear=True):
            err = io.StringIO()
            with redirect_stdout(io.StringIO()), redirect_stderr(err):
                code = main(["--db", db, "--gif-dir", gif_dir])
        ok &= check("Ohne Zugangsdaten Exit 1 mit Namen",
                    code == 1 and "MUX_TOKEN_ID" in err.getvalue() and "MUX_TOKEN_SECRET" in err.getvalue())
        conn.close()
    if ok:
        print(f"aufbewahrung Selbsttest: {passed[0]} Pruefungen bestanden")
    return ok


if __name__ == "__main__":
    sys.exit(main())
