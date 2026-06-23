"""Populate bedrock.staff_user_id_map (staff_user_id → name/email).

staff_contact_relationships.staff_user_id references public.users.user_id (the
platform/Pathfinder user id). The bedrock app role (bedrock_user) can't read
public.users directly (RLS), so this map is the bridge that lets the jobs app
resolve "Connected on LinkedIn" staff names.

The roster below was read from public.users via readonly_user (which Pathfinder
also uses: JOIN users u ON scr.staff_user_id = u.user_id). Re-run after pulling
a fresh snapshot if the staff roster changes. Idempotent UPSERT.

Run:  python -m scripts.populate_staff_user_map
"""
import asyncio
import os

from dotenv import load_dotenv

# staff_user_id → (display_name, email), sourced from public.users.
STAFF: dict[int, tuple[str, str]] = {
    3:   ("Carlos Godoy",       "carlosgodoy@pursuit.org"),
    4:   ("Joanna Patterson",   "joanna@pursuit.org"),
    5:   ("Greg Hogue",         "gregh@pursuit.org"),
    6:   ("Jac Reverand",       "jac@pursuit.org"),
    7:   ("David Yang",         "david@pursuit.org"),
    10:  ("Stefano Barros",     "stefano@pursuit.org"),
    119: ("Kirstie Chen",       "kirstie@pursuit.org"),
    124: ("Yoshiyuki Minami",   "yoshi@pursuit.org"),
    129: ("Afiya Augustine",    "afiya@pursuit.org"),
    219: ("Andrew Tein",        "andrew@pursuit.org"),
    232: ("Victoria Mayo",      "victoriam@pursuit.org"),
    233: ("JP Bowditch",        "jp@pursuit.org"),
    335: ("Guilherme Barros",   "guilherme@pursuit.org"),
    385: ("Trent Whisenant",    "trent@pursuit.org"),
    467: ("Nick Simmons",       "nick@pursuit.org"),
    505: ("An Jimenez",         "an@pursuit.org"),
    506: ("Agnieszka Zebzda",   "agnieszka@pursuit.org"),
    519: ("Allie Mikalatos",    "allie.mikalatos@pursuit.org"),
    550: ("Erica Wong",         "ericawong@pursuit.org"),
    665: ("Johnny Nguyen",      "johnny.nguyen@pursuit.org"),
    691: ("Damon Kornhauser",   "damon.kornhauser@pursuit.org"),
    698: ("Avni Nahar",         "avni@pursuit.org"),
    709: ("Laura Capucilli",    "laura@pursuit.org"),
    723: ("Amed Sylla",         "amed.sylla@pursuit.org"),
}


async def main() -> None:
    import asyncpg

    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        n = 0
        for sid, (name, email) in STAFF.items():
            await conn.execute(
                """
                INSERT INTO bedrock.staff_user_id_map (staff_user_id, email, display_name, updated_at)
                VALUES ($1, $2, $3, now())
                ON CONFLICT (staff_user_id) DO UPDATE
                  SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = now()
                """,
                sid, email, name,
            )
            n += 1
        resolved = await conn.fetchval(
            "SELECT count(*) FROM bedrock.staff_user_id_map WHERE display_name IS NOT NULL"
        )
        print(f"upserted {n} staff; map now has {resolved} named entries")
    finally:
        await conn.close()


if __name__ == "__main__":
    load_dotenv()
    asyncio.run(main())
