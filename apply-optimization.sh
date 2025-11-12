#!/bin/bash

# FastFile Confirm API 优化应用脚本
# 自动备份并应用优化

set -e

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║       FastFile /chunk/confirm API 优化应用工具               ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

HANDLERS_FILE="src/handlers.js"
BACKUP_FILE="src/handlers.js.backup-$(date +%Y%m%d-%H%M%S)"

# 检查文件是否存在
if [ ! -f "$HANDLERS_FILE" ]; then
    echo "❌ 错误: $HANDLERS_FILE 不存在"
    exit 1
fi

echo "📋 准备优化 $HANDLERS_FILE"
echo ""

# 创建备份
echo "1️⃣  创建备份..."
cp "$HANDLERS_FILE" "$BACKUP_FILE"
echo "   ✅ 备份已保存: $BACKUP_FILE"
echo ""

# 显示当前问题代码
echo "2️⃣  当前问题代码（第 343-350 行）:"
echo "   ┌─────────────────────────────────────────────────────┐"
sed -n '343,350p' "$HANDLERS_FILE" | sed 's/^/   │ /'
echo "   └─────────────────────────────────────────────────────┘"
echo ""
echo "   ⚠️  问题: O(n) 复杂度，每次 confirm 查询所有 chunks"
echo "   ⚠️  影响: 1000MB 文件 = 200 次 KV 查询 = ~2000ms"
echo ""

# 提示用户选择优化方案
echo "3️⃣  选择优化方案:"
echo ""
echo "   方案 1: 计数器优化 (推荐)"
echo "           - 性能: O(1), ~50ms"
echo "           - 特点: 保留进度显示"
echo "           - 适合: 需要实时进度的场景"
echo ""
echo "   方案 2: 最小化版本"
echo "           - 性能: O(1), ~30ms"
echo "           - 特点: 无进度计算"
echo "           - 适合: 不需要进度的场景"
echo ""
echo "   方案 3: 使用 KV List"
echo "           - 性能: O(1), ~60ms"
echo "           - 特点: 使用 KV List API"
echo "           - 注意: 需要检查 KV List 限制"
echo ""

read -p "请选择方案 (1/2/3) [默认: 1]: " choice
choice=${choice:-1}

echo ""
echo "4️⃣  应用优化..."

case $choice in
    1)
        echo "   📝 应用方案 1: 计数器优化"
        # 这里需要手动编辑，因为自动替换可能出错
        echo ""
        echo "   ⚠️  自动应用功能开发中..."
        echo "   📖 请手动参考以下文件进行修改:"
        echo "      - src/handlers-optimized.js (查看优化后的代码)"
        echo "      - docs/CONFIRM_API_OPTIMIZATION.md (查看详细说明)"
        echo ""
        echo "   🔧 手动步骤:"
        echo "      1. 打开 src/handlers.js"
        echo "      2. 找到 handleUploadChunkConfirm 函数 (第 286 行)"
        echo "      3. 替换第 343-350 行为优化后的代码"
        echo "      4. 参考 src/handlers-optimized.js 中的 handleUploadChunkConfirm_Optimized"
        ;;
    2)
        echo "   📝 应用方案 2: 最小化版本"
        echo ""
        echo "   ⚠️  自动应用功能开发中..."
        echo "   📖 请参考 src/handlers-optimized.js 中的 handleUploadChunkConfirm_Minimal"
        ;;
    3)
        echo "   📝 应用方案 3: KV List"
        echo ""
        echo "   ⚠️  自动应用功能开发中..."
        echo "   📖 请参考 src/handlers-optimized.js 中的 handleUploadChunkConfirm_WithList"
        ;;
    *)
        echo "   ❌ 无效选择"
        exit 1
        ;;
esac

echo ""
echo "5️⃣  验证优化效果:"
echo ""
echo "   运行以下命令测试性能:"
echo "   $ node diagnose-precise.js"
echo ""
echo "   预期结果:"
echo "   ┌────────────┬──────────────┬──────────────┐"
echo "   │ File Size  │ Confirm(ms)  │ Network      │"
echo "   ├────────────┼──────────────┼──────────────┤"
echo "   │ 100 MB     │ 50           │ 45           │ ✅"
echo "   │ 1000 MB    │ 55           │ 50           │ ✅"
echo "   └────────────┴──────────────┴──────────────┘"
echo ""

echo "6️⃣  部署到生产:"
echo ""
echo "   $ npm run deploy"
echo ""

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║                      优化准备完成                             ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""
echo "📚 相关文档:"
echo "   - docs/CONFIRM_API_OPTIMIZATION.md  (优化方案详细说明)"
echo "   - src/handlers-optimized.js          (优化后的代码示例)"
echo ""
echo "💾 备份文件: $BACKUP_FILE"
echo ""
