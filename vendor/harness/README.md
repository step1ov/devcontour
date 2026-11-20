# Закреплённая версия harness

Зависимость `devcontour-harness` — точная версия из npm registry; она не
вкладывается в архив DevContour. `package-lock.json` фиксирует resolved и
integrity опубликованных байтов; при закреплении integrity сверена с
проверенным архивом. Смена версии — новый выпуск DevContour:
`node scripts/pin-harness.mjs <версия> --commit <SHA> --archive <архив>`.

| Версия         | Integrity опубликованного пакета                                                                  | Исходный commit harness                    |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0.1.0-alpha.58 | `sha512-2ISgBfvHoq4AFg20VCn4SIV1mBugPmTyZ2f2qwGR2nN/A+zuihZD+DVJc74YaO+5d0e5QMBWFALh+yFWVn4Tug==` | `2a46a19e5f63ac5edd4e326788317c752a4e958d` |
