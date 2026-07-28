#!/data/data/com.termux/files/usr/bin/sh
# Wrapper for the Android/Termux Sheng Siong runner, launched by
# termux-job-scheduler. It:
#   - fixes PATH (JobScheduler runs with a minimal environment),
#   - holds a wake-lock so Android doesn't suspend mid-scan,
#   - runs `npm run push-ss` from the repo root (self-gated: no-op if today's
#     data was already pushed),
#   - logs to ~/push-ss.log and releases the wake-lock.
#
# Register it (once):
#   termux-job-scheduler --script ~/NTUC-and-other-scrapers-nutrition/phone-run.sh \
#     --period-ms 10800000 --network any --persisted true
# Watch it:   tail -f ~/push-ss.log
export PATH="/data/data/com.termux/files/usr/bin:$PATH"

cd "$(dirname "$0")" || exit 1

termux-wake-lock 2>/dev/null
echo "=== $(date) : phone-run start ===" >> "$HOME/push-ss.log"
npm run push-ss >> "$HOME/push-ss.log" 2>&1
status=$?
echo "=== $(date) : phone-run done (exit $status) ===" >> "$HOME/push-ss.log"
termux-wake-unlock 2>/dev/null
exit $status
