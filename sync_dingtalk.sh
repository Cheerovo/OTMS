#!/bin/bash
cd /Users/wentishaonv/Desktop/开发项目/OTMS
/opt/homebrew/bin/node sync_dingtalk.js >> /Users/wentishaonv/Desktop/开发项目/OTMS/sync.log 2>&1
echo "--- $(date) ---" >> /Users/wentishaonv/Desktop/开发项目/OTMS/sync.log
