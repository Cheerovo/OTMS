#!/bin/bash
cd /Users/wentishaonv/Desktop/OTMS
/opt/homebrew/bin/node sync_dingtalk.js >> /Users/wentishaonv/Desktop/OTMS/sync.log 2>&1
echo "--- $(date) ---" >> /Users/wentishaonv/Desktop/OTMS/sync.log
