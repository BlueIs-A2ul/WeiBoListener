#!/bin/sh
# 把历史提交里的真实微博 ID / UID 换成示例值
for pair in 1234567890123456:1234567890123456 9876543210:9876543210 AbCdEfGhIj:AbCdEfGhIj; do
  from=${pair%%:*}
  to=${pair##*:}
  grep -rl --exclude-dir=.git -- "$from" . 2>/dev/null | xargs -r sed -i "s/$from/$to/g"
done
exit 0
