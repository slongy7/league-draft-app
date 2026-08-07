#!/usr/bin/env python3
"""
Expands the K and D/ST pools to all 32 NFL teams. Previously only 8 kickers
and 14 D/STs existed — too few for the app's own default settings (10 teams
need 10 K + 10 DST) or its max (16 teams), so some teams could never fill
those roster slots. Appends the missing teams with real-ish starters, then
enrich_players.py should be re-run to fill in age/stats/projPts for them.

Run: python3 scripts/expand_k_dst.py && python3 scripts/enrich_players.py
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).parent.parent
PLAYERS_PATH = ROOT / "src" / "players.json"

MISSING_K = {
    "ARI": "Chad Ryland", "ATL": "Younghoe Koo", "BUF": "Tyler Bass",
    "CAR": "Ryan Fitzgerald", "CHI": "Cairo Santos", "CIN": "Evan McPherson",
    "CLE": "Dustin Hopkins", "DEN": "Wil Lutz", "GB": "Brandon McManus",
    "IND": "Matt Gay", "KC": "Harrison Butker", "LAR": "Joshua Karty",
    "LV": "Daniel Carlson", "MIA": "Jason Sanders", "MIN": "Will Reichard",
    "NE": "Joey Slye", "NO": "Blake Grupe", "NYG": "Graham Gano",
    "NYJ": "Greg Zuerlein", "PHI": "Jake Elliott", "PIT": "Chris Boswell",
    "TB": "Chase McLaughlin", "TEN": "Nick Folk", "WAS": "Zane Gonzalez",
}

TEAM_NAMES = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BUF": "Buffalo Bills",
    "CAR": "Carolina Panthers", "CHI": "Chicago Bears", "CIN": "Cincinnati Bengals",
    "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys", "IND": "Indianapolis Colts",
    "LV": "Las Vegas Raiders", "MIA": "Miami Dolphins", "NO": "New Orleans Saints",
    "NYG": "New York Giants", "NYJ": "New York Jets", "SF": "San Francisco 49ers",
    "TB": "Tampa Bay Buccaneers", "TEN": "Tennessee Titans", "WAS": "Washington Commanders",
}
MISSING_DST = list(TEAM_NAMES.keys())


def main():
    players = json.loads(PLAYERS_PATH.read_text())
    next_id = max(p["id"] for p in players) + 1

    team_bye = {}
    for p in players:
        team_bye.setdefault(p["team"], p["bye"])

    existing_k = sum(1 for p in players if p["pos"] == "K")
    existing_dst = sum(1 for p in players if p["pos"] == "DST")

    k_rank = existing_k
    for team, name in MISSING_K.items():
        k_rank += 1
        players.append({
            "id": next_id, "name": name, "pos": "K", "team": team,
            "bye": team_bye.get(team, 10), "adp": next_id, "posRank": f"K{k_rank}",
        })
        next_id += 1

    dst_rank = existing_dst
    for team in MISSING_DST:
        dst_rank += 1
        players.append({
            "id": next_id, "name": f"{TEAM_NAMES[team]} D/ST", "pos": "DST", "team": team,
            "bye": team_bye.get(team, 10), "adp": next_id, "posRank": f"DST{dst_rank}",
        })
        next_id += 1

    PLAYERS_PATH.write_text(json.dumps(players, separators=(",", ": ")))
    print(f"Added {len(MISSING_K)} kickers and {len(MISSING_DST)} D/STs -> {len(players)} total players")


if __name__ == "__main__":
    main()
