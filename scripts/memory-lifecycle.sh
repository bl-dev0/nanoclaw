#!/bin/bash
MEMORY_BASE="$HOME/nanoclaw-data/memory"
for group_dir in "$MEMORY_BASE"/*/; do
  memory_dir="$group_dir/memory"
  [ -d "$memory_dir" ] || continue
  find "$memory_dir" -name "*.md" -mtime +30 -exec gzip {} \;
  find "$memory_dir" -name "*.md.gz" -mtime +90 -delete
done
