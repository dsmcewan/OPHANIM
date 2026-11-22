#!/usr/bin/env bash
set -eu
# Portable defaults, each overridable: the node on PATH at install time, ~/.local/bin, ~/Projects/OPHANIM-shared.
if [ -z "${OPHANIM_NODE_BIN:-}" ]; then
  node_path=$(command -v node) || { echo 'node is not on PATH; set OPHANIM_NODE_BIN to the directory that holds it' >&2; exit 1; }
  OPHANIM_NODE_BIN=$(dirname -- "$node_path")
fi
node_bin=$OPHANIM_NODE_BIN
local_bin=${OPHANIM_LOCAL_BIN:-$HOME/.local/bin}
export PATH="$node_bin:$local_bin:$PATH"
source_root=$(cd -- "$(dirname -- "$0")" && pwd -P)
workspace=${OPHANIM_WORKSPACE:-$HOME/Projects/OPHANIM-shared}
target="$workspace/collaboration"
umask 077
mkdir -p "$target" "$target/state" "$HOME/.config/systemd/user"
for source in store.mjs cli.mjs mcp-server.mjs mcp-client.mjs desktop-store.mjs github-bridge.mjs cloud-transport.mjs agent-instructions.md config.json; do
  cp -- "$source_root/$source" "$target/$source"
done
{
  printf '#!/usr/bin/env bash\nset -eu\n'
  printf 'export PATH=%q:%q:"$PATH"\n' "$node_bin" "$local_bin"
  printf 'exec node %q "$@"\n' "$target/cli.mjs"
} > "$workspace/collab"
chmod 700 "$workspace/collab"
node -e 'process.stdout.write(JSON.stringify({mcpServers: {ophanim_collab: {command: process.argv[1], args: ["mcp"], env: {OPHANIM_COLLAB_AGENT: "claude"}}}}) + "\n")' "$workspace/collab" > "$target/claude.mcp.json"
{
  printf '#!/usr/bin/env bash\nset -eu\n'
  printf 'export PATH=%q:%q:"$PATH"\n' "$node_bin" "$local_bin"
  printf 'root=%q\nworkspace=%q\n' "$target" "$workspace"
  cat <<'EOF'
client=${1:?codex or claude}; shift
export OPHANIM_COLLAB_AGENT="$client"
case "$client" in
  codex)
    exec codex -c "mcp_servers.ophanim_collab.command=\"$workspace/collab\"" -c 'mcp_servers.ophanim_collab.args=["mcp"]' -c 'mcp_servers.ophanim_collab.env.OPHANIM_COLLAB_AGENT="codex"' "$@"
    ;;
  claude)
    exec claude --mcp-config "$root/claude.mcp.json" --append-system-prompt "$(cat "$root/agent-instructions.md")" "$@"
    ;;
  *) echo 'Expected codex or claude' >&2; exit 2;;
esac
EOF
} > "$target/open-agent"
chmod 700 "$target/open-agent"
(
  cd "$workspace/OPHANIM"
  if ! claude mcp get ophanim_collab >/dev/null 2>&1; then
    claude mcp add ophanim_collab --scope local --env OPHANIM_COLLAB_AGENT=claude -- "$workspace/collab" mcp
  fi
)
if ! grep -q 'collaboration/open-agent' "$workspace/open"; then
  cp -p -- "$workspace/open" "$target/open.before-collaboration"
  python3 - "$workspace/open" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); text=p.read_text()
old='    exec "$client" "$@"'
new='    exec "$workspace/collaboration/open-agent" "$client" "$@"'
if text.count(old)!=1: raise SystemExit('Launcher shape changed; leave it unchanged')
p.write_text(text.replace(old,new))
PY
fi
cat > "$HOME/.config/systemd/user/ophanim-collaboration.service" <<EOF
[Unit]
Description=OPHANIM Codex and Claude collaboration bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$target
Environment=PATH=$node_bin:$local_bin:/usr/bin:/bin
ExecStart=/usr/bin/flock --nonblock $target/state/github.bridge.lock $workspace/collab bridge
Restart=on-failure
RestartSec=15
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now ophanim-collaboration.service
"$workspace/collab" status
