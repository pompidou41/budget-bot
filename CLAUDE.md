Telegram-бот для учёта личных финансов на TS, grammY, Google Sheets.
Docs: [`docs/PLAN.md`](docs/PLAN.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/PRD.md`](docs/PRD.md), [`docs/BACKLOG.md`](docs/BACKLOG.md), [`docs/INFRA.md`](docs/INFRA.md), [`docs/WSL_DEVELOPMENT.md`](docs/WSL_DEVELOPMENT.md).
Memory: .claude/memory/
Dirs: src/=app source | scripts/=deploy | docs/=architecture docs
Done tasks (don't read, only human): [`docs/DONE.md`](docs/DONE.md)

Обязательная документация для изменений функций бота, бизнес-логики, инфраструктуры или архитектуры:

1. **Изменения функций бота**: обновить описание в [Архитектуре](#архитектура) если функция относится к основным модулям (например, добавлена новая команда, изменён флоу хендлера).
2. **Изменения интерфейсов/типов**: обновить описание типов в [Ключевых паттернах](#ключевые-паттерны) (например, если добавлено поле в `UserRecord` или `Transaction`).
3. **Изменения инфраструктуры**: обновить [`docs/INFRA.md`](docs/INFRA.md).
4. **Новые фазы/готовые фичи**: обновить таблицу [Статус разработки](#статус-разработки) в CLAUDE.md.
5. **Изменения состояния (state)**: если изменено управление состоянием в памяти или БД, обновить раздел [Состояние](#состояние).
