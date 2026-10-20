# Mixed Nanny Interface Test Bot

## Purpose

This is an adapter-level test bot flow for the nanny booking scenario. It validates that Telegram text, callback buttons, and voice transcripts all operate on one `DialogueContext`. It does not create real nanny bookings: the test suite injects an in-memory action dispatcher.

## Entry points

- `/start`: explains the test and shows the “Заказать няню (тест)” inline button.
- `/order_nanny`: starts the registered `order-nanny` scenario.
- Inline callback `start:order-nanny`: starts that same scenario from the menu.
- Text and voice updates after start are passed to the shared `DialogueEngine`.

## Mixed-channel contract

1. Scenario start creates one context with `scenarioId=order-nanny`.
2. Text, voice transcript, and button callback inputs call the same `DialogueEngine.processInput`.
3. A voice utterance may fill multiple slots; the engine should ask only for the next missing slot.
4. Button callbacks update slots in that same context, including corrections.
5. Candidate selection uses the scenario's generic candidate binding.
6. Confirmation dispatches through the injected test dispatcher. Tests assert exactly one dispatch.
7. No external LLM/STT API is required by these contract tests. Voice input uses a deterministic test transport; real audio STT remains a separate integration concern.

## Run the tests

```bash
npm install
npx playwright test tests/contract/integration/mixed-nanny-test-bot.spec.ts
```

The test transport substitutes a fixed transcript for a Telegram voice message. This isolates dialogue and channel integration from microphone/audio model quality.

## Scope and limitations

This is not a deployed Telegram bot. The repository's `TelegramBotAdapter` is a transport adapter and the contract suite uses `MockTelegramClient`; Telegram credentials, webhook/polling server, production persistence, and real STT deployment are deliberately not introduced by this test task. The action dispatcher is a test double and does not call a production Domain MCP or create a real order.

A production deployment must provide a real `TelegramClient`, Telegram update delivery, durable dialogue-state storage, and a configured local STT provider. The dialogue contract must remain unchanged when those infrastructure adapters are added.
