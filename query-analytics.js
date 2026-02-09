const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.resolve("relay.db");
const db = new Database(dbPath);

// Get week range
const now = Math.floor(Date.now() / 1000);
const weekAgo = now - 7 * 86400;

// Total stats
const total = db.prepare("SELECT COUNT(*) as c FROM performance_log WHERE timestamp > ?").get(weekAgo);
const successes = db.prepare("SELECT COUNT(*) as c FROM performance_log WHERE timestamp > ? AND outcome = 'success'").get(weekAgo);
const errors = db.prepare("SELECT COUNT(*) as c FROM performance_log WHERE timestamp > ? AND outcome = 'error'").get(weekAgo);
const avgDuration = db.prepare("SELECT AVG(duration_ms) as avg FROM performance_log WHERE timestamp > ? AND duration_ms > 0").get(weekAgo);

// Top skills
const topSkills = db.prepare(
  "SELECT skill, COUNT(*) as count, AVG(duration_ms) as avg_ms FROM performance_log WHERE timestamp > ? GROUP BY skill ORDER BY count DESC LIMIT 10"
).all(weekAgo);

// Error-prone skills
const errorSkills = db.prepare(
  "SELECT skill, COUNT(*) as errors FROM performance_log WHERE timestamp > ? AND outcome = 'error' GROUP BY skill ORDER BY errors DESC LIMIT 5"
).all(weekAgo);

// Bottlenecks
const slowest = db.prepare(
  "SELECT skill, AVG(duration_ms) as avg_ms, MAX(duration_ms) as max_ms, COUNT(*) as count FROM performance_log WHERE timestamp > ? AND duration_ms > 0 GROUP BY skill ORDER BY avg_ms DESC LIMIT 10"
).all(weekAgo);

// Day-by-day breakdown
const dayBreakdown = db.prepare(`
  SELECT strftime('%Y-%m-%d', timestamp, 'unixepoch', 'localtime') as day, 
         COUNT(*) as executions,
         SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
         SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) as errors
  FROM performance_log 
  WHERE timestamp > ?
  GROUP BY day
  ORDER BY day DESC
`).all(weekAgo);

console.log(JSON.stringify({
  week: {
    total: total?.c || 0,
    successes: successes?.c || 0,
    errors: errors?.c || 0,
    avgDuration: avgDuration?.avg || 0,
    successRate: total?.c > 0 ? ((successes?.c || 0) / total.c * 100).toFixed(1) : 0,
    errorRate: total?.c > 0 ? ((errors?.c || 0) / total.c * 100).toFixed(1) : 0
  },
  topSkills,
  errorSkills,
  bottlenecks: slowest,
  dayBreakdown
}, null, 2));

db.close();
