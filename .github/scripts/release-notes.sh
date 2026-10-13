#!/usr/bin/env bash
# 从更新日志里取出指定版本的段落（不含版本标题），供 GitHub Release 使用。
# 用法：release-notes.sh vX.Y.Z [更新日志路径，默认 docs/CHANGELOG.md]
# 找不到这个版本、或段落为空时报错退出，发布工作流靠它在构建镜像前拦住漏写的更新日志。
set -euo pipefail

tag="${1:?用法：release-notes.sh vX.Y.Z [docs/CHANGELOG.md]}"
file="${2:-docs/CHANGELOG.md}"

# 版本标题形如 "## v0.2.0（2026-10-13）"：匹配 "## <tag>" 后面紧跟行尾、空格、"(" 或 "（"。
notes=$(awk -v head="## ${tag}" '
	/^## / {
		if (found) exit
		if (index($0, head) == 1) {
			rest = substr($0, length(head) + 1)
			if (rest == "" || substr(rest, 1, 1) == " " || substr(rest, 1, 1) == "(" || index(rest, "（") == 1) {
				found = 1
				next
			}
		}
	}
	found { print }
' "$file" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}')

if [ -z "${notes//[[:space:]]/}" ]; then
	echo "${file} 里没有 ${tag} 的段落（标题应为 \"## ${tag}（YYYY-MM-DD）\"），请先写好更新日志再打 tag。" >&2
	exit 1
fi
printf '%s\n' "$notes"
