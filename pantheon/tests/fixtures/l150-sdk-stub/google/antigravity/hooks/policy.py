# A STUB of google.antigravity.hooks.policy (register L-150's CI tests): the two rules scripts/agy-seat.py declares.
def allow_all():
  return {"rule": "allow_all"}


def deny(tool, when=None, name=None):
  return {"rule": "deny", "tool": tool, "when": when, "name": name}
