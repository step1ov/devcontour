# Закреплённая версия harness

Зависимость `devcontour-harness` — точная версия из npm registry; она не
вкладывается в архив DevContour. `package-lock.json` фиксирует resolved и
integrity опубликованных байтов; при закреплении integrity сверена с
проверенным архивом. Смена версии — новый выпуск DevContour:
`node scripts/pin-harness.mjs <версия> --commit <SHA> --archive <архив>`.

| Версия         | Integrity опубликованного пакета                                                                  | Исходный commit harness                    |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0.1.0-alpha.47 | `sha512-io2WP00EKy3JRC77qOzlyDh1XtzRI2+h/OeAWC3fwoIr1CeWPZlFtR9dUoU+qi0dzFqN21m4kQ/F1HdkA6O15A==` | `6605a314b56e66edfd32b7e4951425bfa8c337dc` |
