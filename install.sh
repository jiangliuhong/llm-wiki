#!/usr/bin/env bash
# 全局安装 llm-wiki-cli 命令。
#
# 用法: 在仓库根目录执行  ./install.sh   或   bash install.sh
#
# 本脚本会:
#   1. 构建 @llm-wiki/cli 及其依赖 @llm-wiki/kb(跳过无关的 apps/web)
#   2. 将 packages/cli 全局安装,使其暴露 llm-wiki-cli 命令
#   3. 验证命令可用
#
# 说明: 全局安装是软链而非拷贝,因此每次修改源码后重新运行本脚本即可更新全局命令。

set -euo pipefail

# 切到脚本所在目录(仓库根),保证无论从何处调用都能正确解析路径
cd "$(dirname "$0")"

# ---------- 确保 pnpm 全局 bin 在 PATH 中 ----------
# 在非交互 shell(如 CI、被其它进程调用)中 .bashrc 不会自动加载,
# 导致 PNPM_HOME 不在 PATH,pnpm install -g 会报错。
# 这里主动设置,兼容 pnpm 9.x(PNPM_HOME 根目录)与 11.x(PNPM_HOME/bin)。
if [ -z "${PNPM_HOME:-}" ]; then
  export PNPM_HOME="${HOME}/Library/pnpm"
fi
case ":${PATH}:" in
  *":${PNPM_HOME}/bin:"*) ;;
  *) export PATH="${PNPM_HOME}/bin:${PNPM_HOME}:${PATH}" ;;
esac

# ANSI 颜色(仅在交互终端启用,管道/CI 下自动禁用)
if [ -t 1 ]; then
  BOLD='\033[1m'
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  CYAN='\033[0;36m'
  RESET='\033[0m'
else
  BOLD=''; GREEN=''; RED=''; CYAN=''; RESET=''
fi

info()  { printf "${CYAN}▶${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
fail()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

# ---------- 前置检查 ----------
if ! command -v pnpm >/dev/null 2>&1; then
  fail "未找到 pnpm,请先安装 pnpm。"
  exit 1
fi

# ---------- 1. 构建产物 ----------
# 只构建 @llm-wiki/cli 及其依赖(@llm-wiki/kb),跳过无关的 apps/web,
# 既快又避免 web 构建失败阻塞 CLI 安装。
info "构建 @llm-wiki/cli 及其依赖…"
pnpm install --frozen-lockfile
pnpm --filter @llm-wiki/cli... run build
ok "构建完成"

# ---------- 2. 全局安装 CLI ----------
CLI_DIR="$(pwd)/packages/cli"
info "全局安装 @llm-wiki/cli(来自 $CLI_DIR)…"
(
  cd "$CLI_DIR"
  pnpm install -g .
)
ok "全局安装完成"

# ---------- 3. 验证 ----------
if command -v llm-wiki-cli >/dev/null 2>&1; then
  ok "命令可用: $(command -v llm-wiki-cli)"
  printf "\n${BOLD}版本:${RESET}\n"
  llm-wiki-cli --version
else
  fail "llm-wiki-cli 未在 PATH 中。可能需要重新加载 shell: source ~/.bashrc"
  exit 1
fi
