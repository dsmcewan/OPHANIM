# A STUB of google.antigravity.types for register L-150's CI tests (no SDK is installed on the CI runner). It carries only
# what scripts/agy-seat.py uses, with the real SDK's names (google-antigravity 0.1.24). Never used outside the tests.
import enum
from dataclasses import dataclass, field
from typing import Any

from google.antigravity.models import DEFAULT_IMAGE_GENERATION_MODEL, GeminiAPIEndpoint, ModelTarget, ModelType  # noqa: F401


class BuiltinTools(str, enum.Enum):
  LIST_DIR = "list_directory"
  SEARCH_DIR = "search_directory"
  FIND_FILE = "find_file"
  VIEW_FILE = "view_file"
  RUN_COMMAND = "run_command"
  INVOKE_SUBAGENT = "invoke_subagent"
  SEARCH_WEB = "search_web"
  READ_URL_CONTENT = "read_url_content"
  FINISH = "finish"
  START_SUBAGENT = "invoke_subagent"  # the real SDK keeps START_SUBAGENT as a deprecated alias of INVOKE_SUBAGENT


class StopReason(str, enum.Enum):
  UNSPECIFIED = "UNSPECIFIED"
  MAX_MODEL_CALLS_EXCEEDED = "MAX_MODEL_CALLS_EXCEEDED"


class AntigravityConnectionError(Exception):
  """What the real SDK raises when its harness ends a turn on an HTTP 400/401/403 system step."""


@dataclass
class ToolCall:
  name: str
  args: Any = None


@dataclass
class HookResult:
  allow: bool = True


@dataclass
class SubagentCapabilities:
  enabled_tools: list = field(default_factory=list)


@dataclass
class SubagentConfig:
  name: str = ""
  description: str = ""
  system_instructions: str = ""
  capabilities: Any = None


@dataclass
class CapabilitiesConfig:
  enable_subagents: bool = False
  enabled_tools: list = field(default_factory=list)
  max_subagent_depth: Any = None
  allowed_subagents: Any = None


@dataclass
class BudgetConfig:
  max_model_calls: Any = None
  max_tool_calls: Any = None
  max_output_tokens: Any = None


@dataclass
class RetryConfig:
  api_retry: Any = None
