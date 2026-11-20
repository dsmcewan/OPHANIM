# A STUB of google.antigravity.hooks.hooks (register L-150's CI tests): each decorator tags the function with its kind.
def _kind(name):
  def deco(fn):
    fn._l150_hook = name
    return fn
  return deco


pre_tool_call_decide = _kind("pre_tool")
post_tool_call = _kind("post_tool")
on_tool_error = _kind("on_tool_error")
pre_turn = _kind("pre_turn")
post_turn = _kind("post_turn")
