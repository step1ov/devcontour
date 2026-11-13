# Закреплённая версия harness

Зависимость `devcontour-harness` — точная версия из npm registry; она не
вкладывается в архив DevContour. `package-lock.json` фиксирует resolved и
integrity опубликованных байтов; при закреплении integrity сверена с
проверенным архивом. Смена версии — новый выпуск DevContour:
`node scripts/pin-harness.mjs <версия> --commit <SHA> --archive <архив>`.

| Версия         | Integrity опубликованного пакета                                                                  | Исходный commit harness                    |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0.1.0-alpha.45 | `sha512-axBXfhfbQKEqCEN1f5di/8fTRkx5GVypxc6MrGK0f3I5HROoiHD3a61jvnTaGCTlmkUNaVxXzclpWgkfCvbgJA==` | `2e35a29f276b1567be924f38b9d2d4b5460d4f8d` |
