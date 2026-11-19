"""Lanceur multiplateforme (Windows / Mac / Linux) pour la démo TRIAD."""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

os.environ.setdefault("USE_GCP_SNAPSHOT", "true")
os.environ.setdefault("HOST", "0.0.0.0")
os.environ.setdefault("PORT", "8080")


def main() -> None:
    import uvicorn

    port = int(os.environ.get("PORT", "8080"))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"TRIAD démarré sur http://localhost:{port} (mode snapshot={os.environ.get('USE_GCP_SNAPSHOT')})")
    uvicorn.run("triad.api.app:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
