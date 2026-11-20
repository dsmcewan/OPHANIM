# A STUB of google.antigravity.models (register L-150's CI tests): the endpoint and model-target types, as the real SDK
# (google-antigravity 0.1.24, google/antigravity/models.py) names them.
import enum
from dataclasses import dataclass, field
from typing import Any

DEFAULT_MODEL = "gemini-4-hydrogen"
DEFAULT_IMAGE_GENERATION_MODEL = "gemini-3.1-flash-lite-image"


class ModelType(str, enum.Enum):
  TEXT = "text"
  IMAGE = "image"


@dataclass
class GeminiAPIEndpoint:
  base_url: str | None = None
  api_key: str | None = None
  http_headers: dict | None = None


@dataclass
class ModelTarget:
  name: str | None = None
  types: list = field(default_factory=lambda: [ModelType.TEXT])
  endpoint: Any = None
