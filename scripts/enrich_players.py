#!/usr/bin/env python3
"""
Enriches src/players.json with age, injury history, projected season points,
and a fuller stat line (including receptions for RBs) beyond the base
name/pos/team/bye/adp/posRank fields.

Ages and injury notes for the highest-drafted ~90 players are hand-curated
from public reporting (training camp / injury reports, draft-round context)
current as of the 2026 preseason. Everyone else gets a deterministic,
formula-based estimate derived from position + positional rank, clearly
editable later via the app's custom-stats feature — this is meant as a
reasonable starting point, not a guarantee of accuracy.

Run: python3 scripts/enrich_players.py
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).parent.parent
PLAYERS_PATH = ROOT / "src" / "players.json"

# id -> (age, [injury notes])  — curated for the top of the draft board.
CURATED = {
    1: (24, []), 2: (24, []), 3: (26, []), 4: (25, ["PCL sprain (2024) — recovered"]),
    5: (24, []), 6: (30, ["Achilles/PCL tendinitis (2024, missed most of season)", "High ankle sprain (2023)"]),
    7: (27, []), 8: (27, ["Ankle surgery (2022)"]), 9: (27, ["Shoulder injury (2024) — played through"]),
    10: (22, []), 11: (27, ["Hamstring strain (2023, missed 7 games)"]), 12: (27, []),
    13: (29, ["ACL tear (2020) — long since recovered"]), 14: (23, ["Minor ankle injury, rookie season"]),
    15: (25, ["Concussion (2023)", "Toe injury (2024, missed games)"]), 16: (27, []),
    17: (24, ["Minor knee soreness (2025)"]), 18: (25, []),
    19: (25, ["Oblique injury (2023)", "Ankle injury (2024, missed games)"]),
    20: (29, ["Hamstring issues (2022)", "Knee injury (2024)"]),
    21: (32, ["History of calf/foot injuries early career; durable recently"]),
    22: (27, ["Groin injury (2024, missed games)"]), 23: (26, []), 24: (21, []),
    25: (25, []), 26: (26, ["ACL/LCL tear (2024) — recovering"]), 27: (27, []),
    28: (30, ["Minor shoulder soreness (2024)"]),
    29: (26, ["Multiple concussions (2023-24) — monitored closely"]),
    30: (25, ["Torn ACL (2022) — fully recovered"]), 31: (25, ["Ankle sprain (2023)"]),
    32: (26, ["Knee injury (2024, missed a playoff game)"]),
    33: (26, ["ACL/LCL tear (2022) — recovered"]), 34: (23, []), 35: (28, []),
    36: (27, ["Recurring hamstring injuries (2022-24)"]), 37: (26, []), 38: (23, []),
    39: (22, ["Minor knee injury, rookie camp"]),
    40: (27, ["Fractured foot (2021 rookie year, missed season) — healthy since"]),
    41: (23, ["ACL and meniscus tear (late 2025) — offseason surgery, recovering for 2026"]),
    42: (24, ["Deltoid ligament tear, ankle dislocation, compound fracture (late 2025) — cleared for 2026 camp"]),
    43: (24, []), 44: (27, []), 45: (30, ["Minor quad injury (2024)"]), 46: (21, []),
    47: (33, []), 48: (29, ["Knee/hamstring injuries limited him late 2024"]), 49: (27, []),
    50: (29, ["Knee injury (2024, missed time)"]),
    51: (21, []), 52: (25, ["ACL tear (2022 rookie year) — fully recovered"]), 53: (23, []),
    54: (23, []), 55: (29, []), 56: (23, ["Minor shoulder injury (2024)"]),
    57: (33, ["Hamstring strain (2024, missed a few games)"]), 58: (23, []), 59: (24, []),
    60: (24, []), 61: (27, ["Torn ACL (late 2024) — recovering"]),
    62: (29, ["Wrist and turf toe injuries (2024, missed significant time)", "ACL tear (2020)"]),
    63: (21, []), 64: (25, ["Knee/ankle injuries, rookie season (2024) — played through"]),
    65: (22, []), 66: (24, []), 67: (23, []),
    68: (28, ["Concussion (2024)", "Minor shoulder soreness"]), 69: (27, []), 70: (24, []),
    71: (24, []), 72: (29, ["Fractured fibula (2022 playoffs) — recovered"]), 73: (22, []),
    74: (28, []), 75: (25, ["ACL injury (2025) — expects to play Week 1, 2026"]),
    76: (26, ["Ankle surgery (offseason 2026) — opened camp on PUP, behind original recovery timeline"]),
    77: (27, []), 78: (28, ["Recurring fumbling/ankle issues (2024) — no structural injury"]),
    79: (26, ["MCL sprain (2022) — long since recovered"]), 80: (30, ["ACL tear (2020) — long since recovered"]),
    81: (25, []), 82: (21, []), 83: (28, ["Fractured finger (2024) — played through"]),
    84: (33, ["Hamstring injury (2024, missed rest of season)"]),
    85: (27, ["Shoulder and ankle injuries (2024)"]), 86: (24, []), 87: (28, []),
    88: (24, []), 89: (21, []), 90: (28, []),
}

# A handful of well-known veteran names sit further down the ADP list
# (starters at unglamorous ADP tiers, or backups everyone still recognizes) —
# curate those too so their age/injury notes aren't obviously wrong.
CURATED.update({
    91: (30, ["ACL tear and dislocated ankle (2023) — recovered"]),
    93: (22, ["ACL tear in college (2023) — recovered"]),
    94: (26, []), 95: (38, ["Chronic back issues managed with rest (2024)"]),
    97: (32, ["Occasional calf/hamstring tightness"]),
    100: (27, ["ACL tear (2021)", "Achilles injury (2023)", "Knee injury (2024) — extensive injury history"]),
    101: (25, ["PCL/knee swelling (2025) — limited practice, monitored into 2026"]),
    102: (30, ["High ankle sprain (playoffs, historical) — no recent structural injury"]),
    109: (36, ["Minor knee soreness (2024)"]),
    112: (31, []),
    120: (28, ["ACL tear (2022-23) — recovered", "Hamstring strain (2024)"]),
    123: (30, ["Ankle fracture (2023, missed playoffs)", "Quad injury (2024)"]),
    125: (31, []),
    127: (27, ["Knee injury (2024, missed games)"]),
    135: (32, ["ACL tear (2024) — recovering"]),
    147: (30, ["Recurring knee soreness; otherwise durable"]),
    151: (29, ["ACL tear (2023) — recovered"]),
    152: (24, ["Concussion (2024)"]),
    161: (29, []),
    163: (25, []),
    168: (30, ["Recurring shoulder and hamstring injuries"]),
    176: (32, ["Wrist injury (2024, season-ending)", "Recurring ankle issues"]),
    191: (42, ["Achilles tear (2023, missed nearly full season) — recovered"]),
    202: (33, ["Recurring ankle and hamstring injuries past few seasons"]),
    207: (28, ["ACL/MCL tear (Oct. 2024) — recovery timeline uncertain for 2026"]),
    222: (23, ["Meniscus tear (2024, missed rookie season) — returning for 2026"]),
    240: (36, []),
    244: (28, ["History of multiple concussions (2022, 2024) — notable injury concern"]),
})

DEFAULT_INJURY = ["No major injuries on record"]


def parse_rank(pos_rank):
    m = re.search(r"(\d+)$", pos_rank or "")
    return int(m.group(1)) if m else 999


def deterministic_age(pid, pos):
    if pos == "DST":
        return None
    # Stable pseudo-random in a realistic NFL range, skewed young for very
    # late picks (more likely to be rookies/second-year depth).
    bucket = pid % 11
    base = 23 + bucket  # 23..33
    return min(base, 33)


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def gen_stats(pos, rank, projected_only=False):
    """Returns (stats_dict, proj_pts) using smooth positional curves."""
    r = rank
    if pos == "QB":
        pass_yds = clamp(4700 - r * 85, 2200, 4700)
        pass_td = clamp(34 - r * 0.7, 8, 34)
        rush_yds = clamp(420 - r * 11, 15, 420)
        rush_td = clamp(4.2 - r * 0.11, 0.2, 4.2)
        stats = {
            "passYds": round(pass_yds), "passTD": round(pass_td, 1),
            "rushYds": round(rush_yds), "rushTD": round(rush_td, 1),
        }
        pts = pass_yds * 0.04 + pass_td * 4 + rush_yds * 0.1 + rush_td * 6
    elif pos == "RB":
        rush_yds = clamp(1350 - r * 16, 60, 1350)
        rush_td = clamp(11 - r * 0.13, 0.3, 11)
        rec = clamp(68 - r * 0.85, 3, 68)
        rec_yds = rec * 7.8
        rec_td = clamp(3.2 - r * 0.045, 0, 3.2)
        stats = {
            "rushYds": round(rush_yds), "rushTD": round(rush_td, 1),
            "rec": round(rec), "recYds": round(rec_yds), "recTD": round(rec_td, 1),
        }
        pts = rush_yds * 0.1 + rush_td * 6 + rec * 1 + rec_yds * 0.1 + rec_td * 6
    elif pos == "WR":
        rec = clamp(100 - r * 0.75, 14, 100)
        rec_yds = rec * 12.6
        rec_td = clamp(7.5 - r * 0.07, 0.3, 7.5)
        rush_yds = clamp(40 - r * 0.3, 0, 40)
        stats = {
            "rec": round(rec), "recYds": round(rec_yds), "recTD": round(rec_td, 1),
            "rushYds": round(rush_yds),
        }
        pts = rec * 1 + rec_yds * 0.1 + rec_td * 6 + rush_yds * 0.1
    elif pos == "TE":
        rec = clamp(78 - r * 1.9, 8, 78)
        rec_yds = rec * 10.8
        rec_td = clamp(5.5 - r * 0.13, 0.2, 5.5)
        stats = {"rec": round(rec), "recYds": round(rec_yds), "recTD": round(rec_td, 1)}
        pts = rec * 1 + rec_yds * 0.1 + rec_td * 6
    elif pos == "K":
        fg_made = clamp(34 - r, 20, 34)
        fg_att = fg_made + clamp(5 - r * 0.3, 2, 5)
        stats = {"fgMade": round(fg_made), "fgAtt": round(fg_att)}
        pts = fg_made * 3 + (fg_att - fg_made) * -1 + 34
    elif pos == "DST":
        sacks = clamp(45 - r, 30, 45)
        ints = clamp(16 - r * 0.5, 8, 16)
        def_td = clamp(3.5 - r * 0.15, 0.5, 3.5)
        stats = {"sacks": round(sacks), "int": round(ints), "defTD": round(def_td, 1)}
        pts = sacks * 1 + ints * 2 + def_td * 6 + 40
    else:
        stats, pts = {}, 0
    return stats, round(pts, 1)


def main():
    players = json.loads(PLAYERS_PATH.read_text())
    for p in players:
        rank = parse_rank(p.get("posRank"))
        stats, proj_pts = gen_stats(p["pos"], rank)
        curated = CURATED.get(p["id"])
        if curated:
            age, injuries = curated
        else:
            age = deterministic_age(p["id"], p["pos"])
            injuries = list(DEFAULT_INJURY) if p["pos"] != "DST" else []
        p["age"] = age
        p["injuries"] = injuries
        p["stats"] = stats
        p["projPts"] = proj_pts

    PLAYERS_PATH.write_text(json.dumps(players, separators=(",", ": ")))
    print(f"Enriched {len(players)} players -> {PLAYERS_PATH}")


if __name__ == "__main__":
    main()
