#!/bin/bash
# 按仓库名查出 Obsidian vault 在本机的实际地址，打印到标准输出。
# 用法：scripts/vault-path.sh MindCraft
#
# 地址来自 Obsidian 自己维护的仓库登记表 obsidian.json，vault 搬家后
# 只要在 Obsidian 里打开过一次，这里查到的就是新地址，脚本不用再改。
# 读的是磁盘上的文件，Obsidian 没开也能用。
# 同名仓库有多个时，取最近打开的那个；查不到就报错退出。

set -e

VAULT_NAME="${1:?用法：vault-path.sh <仓库名>}"
REGISTRY="$HOME/Library/Application Support/obsidian/obsidian.json"

if [ ! -f "$REGISTRY" ]; then
  echo "❌ 找不到 Obsidian 仓库登记表：$REGISTRY" >&2
  exit 1
fi

python3 - "$VAULT_NAME" "$REGISTRY" <<'PY'
import json, os, sys

name, registry = sys.argv[1], sys.argv[2]
with open(registry, encoding="utf-8") as f:
    vaults = json.load(f).get("vaults", {}).values()

matches = [v for v in vaults if os.path.basename(v.get("path", "").rstrip("/")) == name]
if not matches:
    sys.exit(f"❌ Obsidian 里没有叫 {name} 的仓库，请先在 Obsidian 里打开它一次")

best = max(matches, key=lambda v: v.get("ts", 0))
if not os.path.isdir(best["path"]):
    sys.exit(f"❌ 登记的地址不存在：{best['path']}，请在 Obsidian 里重新打开 {name}")
print(best["path"])
PY
