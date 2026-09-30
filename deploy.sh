#!/bin/bash

# Spark Memo - Deploy Script
# 构建项目并部署到 Obsidian 插件目录

set -e  # Exit on error

# 只写仓库名，实际地址由 scripts/vault-path.sh 从 Obsidian 的仓库登记表里查出，
# vault 搬家后不用改这里。查不到会报错退出，不会复制到错的地方。
VAULT_NAME="MindCraft"
VAULT_PATH="$("$(dirname "$0")/scripts/vault-path.sh" "$VAULT_NAME")"
PLUGIN_DIR="$VAULT_PATH/.obsidian/plugins/spark-memo"

echo "📦 Building Spark Memo..."
npm run build

echo ""
echo "📤 Syncing to Obsidian..."
mkdir -p "$PLUGIN_DIR"
cp dist/main.js "$PLUGIN_DIR/"
cp manifest.json "$PLUGIN_DIR/"
cp styles.css "$PLUGIN_DIR/"

echo ""
echo "✅ Build & Sync complete!"
echo "📍 Installed to: $PLUGIN_DIR"
echo ""
echo "💡 Tip: Reload the plugin in Obsidian (⌘+P → Reload app without saving)"
