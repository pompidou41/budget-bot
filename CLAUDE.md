Однопользовательский Telegram-бот для учёта личных финансов на TS + grammY: текст, голос или фото → AI (OpenRouter Gemini, Groq Whisper) → черновик → строка в лист «Операции» Google-таблицы v2.
Docs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/SHEET_V2.md`](docs/SHEET_V2.md) (структура таблицы), [`docs/PRD.md`](docs/PRD.md), [`docs/BACKLOG.md`](docs/BACKLOG.md), [`docs/INFRA.md`](docs/INFRA.md), [`docs/PLAN.md`](docs/PLAN.md), [`docs/WSL_DEVELOPMENT.md`](docs/WSL_DEVELOPMENT.md).
Memory: .claude/memory/
Dirs: src/=app source | test/=vitest | scripts/=deploy, check-sheet | docs/=architecture docs
Done tasks (don't read, only human): [`docs/DONE.md`](docs/DONE.md)

Команды: `yarn dev` · `yarn typecheck` · `yarn lint` · `yarn test` · `yarn check-sheet` (read-only проверка таблицы).
Lockfile — yarn classic v1; если локальный `yarn` — это Yarn 4 из corepack, использовать `npx yarn@1.22.22 …`.
Бот пишет только `Операции!A:K`; L:T и остальные листы — формулы, не трогать.
Вывод `/ask`, `/balance`, `/report` — rich messages (Bot API 10.3) с откатом на HTML: `RENDER_MODE=html`.

Обязательная документация для изменений функций бота, бизнес-логики, инфраструктуры или архитектуры:

1. **Изменения функций бота**: обновить «Модули» и схему потока в [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (новая команда, изменён флоу хендлера).
2. **Изменения интерфейсов/типов**: обновить «Ключевые паттерны» в [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (например, поле в `Operation`, `Draft`, `AppDeps`).
3. **Изменения инфраструктуры**: обновить [`docs/INFRA.md`](docs/INFRA.md).
4. **Новые фазы/готовые фичи**: обновить таблицу [Статус разработки](#статус-разработки) ниже.
5. **Изменения состояния (state)**: обновить раздел «Состояние» в [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Статус разработки

| Фаза                                                                      | Статус                                  |
| ------------------------------------------------------------------------- | --------------------------------------- |
| v1: мультиюзер, регистрация, SQLite, «Сводка», шаблонный парсер, отчёты   | удалено (2026-09)                       |
| v2: таблица v2, AI-ввод (текст/голос/фото), черновики, `/add`, `/undo`, `/balance` | ✅ реализовано, ждёт проверки на копии таблицы и деплоя |
| v2.1: `/settings` — счёт по умолчанию (`T_MAIN`), свои алиасы, правила чтения скриншотов | ✅ реализовано, ждёт проверки |
| v2.2: `/ask` — вопросы про финансы (анализ, прогноз, план) поверх истории «Операции» | ✅ реализовано, ждёт проверки |
| v2.3: reply переживает рестарт (`data/drafts.json`, `data/conversations.json`), голосовой follow-up | ✅ реализовано, ждёт проверки |
| v2.4: `/report` — траты по категориям × неделям/месяцам, недельный срез в `/ask`          | ✅ реализовано, ждёт проверки |
| v2.5: rich messages (Bot API 10.3) для `/ask`, `/balance`, `/report`; `RENDER_MODE`        | ✅ реализовано, ждёт проверки |
| v2.6: аналитик на `anthropic/claude-sonnet-5`, лестница JSON-форматов в OpenRouter         | ✅ реализовано, ждёт проверки |
