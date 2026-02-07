# Kingston — Architecture Reference

**Updated:** 2026-02-07
**Status:** All systems operational (194 skills)

---

## Implemented Systems

All 7 systems from the original Phoenix proposal are **implemented and running**.

### 1. Voice & Phone Calls
- **Skills:** `phone.call`
- **Pipeline:** Twilio → Deepgram STT → Claude → ElevenLabs TTS
- **Files:** `src/voice/` (server.ts, deepgram.ts, elevenlabs.ts, outbound.ts)
- **Config:** VOICE_ENABLED, TWILIO_*, DEEPGRAM_API_KEY, ELEVENLABS_*

### 2. Hot-Reload .env
- **Skills:** `config.reload`
- **File:** `src/config/env.ts` (watchEnv + reloadEnv)
- **Auto:** Watches .env, reloads on change

### 3. Scheduler
- **Skills:** `scheduler.add`, `scheduler.list`, `scheduler.cancel`
- **File:** `src/scheduler/scheduler.ts`
- **Events:** morning_briefing, evening_checkin, heartbeat, reminders

### 4. Error Tracking & Learning
- **Skills:** `errors.recent`, `errors.resolve`
- **Learning:** `learn.pattern`, `learn.preferences`, `learn.forget`
- **MISS/FIX v2:** `src/memory/self-review.ts` (error clustering, rule generation)
- **Agent:** Learner agent (2h heartbeat) reviews and generates rules

### 5. Self-Optimization
- **Skills:** `optimize.analyze`, `optimize.suggest`, `optimize.benchmark`, `optimize.refactor`
- **Memory:** `memory.update`, `memory.query`, `memory.list`
- **Meta:** `skills.create` (Kingston can create new skills)

### 6. Git Operations
- **Skills:** `git.status`, `git.diff`, `git.commit`, `git.push`, `git.branch`, `git.log`

### 7. File System
- **Skills:** `files.list`, `files.read`, `files.write`, `files.read_anywhere`, `files.write_anywhere`, `files.search`, `files.move`, `files.delete`, `files.watch`

### 8. Multi-Agent System
- **Skills:** `agents.list`, `agents.status`, `agents.start`, `agents.stop`
- **Agents:** Scout (30min), Analyst (60min), Learner (2h), Executor (5min)
- **Files:** `src/agents/` (base.ts, registry.ts, startup.ts, definitions/)

---

## Important: Use ONLY skills from the tool catalog

Kingston MUST NOT invent or guess skill names. The tool catalog provided in each prompt is the **single source of truth** for available skills. If a skill is not in the catalog, it does not exist.

### Common mistakes to avoid
- There is NO `self.notify` — use `telegram.send`
- There is NO `call.nicolas` — use `phone.call`
- There is NO `self.optimize` — use `optimize.analyze`
- There is NO `telegram.voice` — use `phone.call`
- There is NO `reload-env` — use `config.reload`
- There is NO `schedule-add` — use `scheduler.add`
- There is NO `errors-recent` — use `errors.recent`
