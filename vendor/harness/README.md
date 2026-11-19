# Закреплённая версия harness

Зависимость `devcontour-harness` — точная версия из npm registry; она не
вкладывается в архив DevContour. `package-lock.json` фиксирует resolved и
integrity опубликованных байтов; при закреплении integrity сверена с
проверенным архивом. Смена версии — новый выпуск DevContour:
`node scripts/pin-harness.mjs <версия> --commit <SHA> --archive <архив>`.

| Версия         | Integrity опубликованного пакета                                                                  | Исходный commit harness                    |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0.1.0-alpha.53 | `sha512-BtaOIj/XE7LRkGmcQZiL0mXnWYlopTO9VEaDZOFyb7vN8AG+YqlSSPvSg2ZuFQGGZRVN6XKDSBLG0watnzQd1g==` | `885e0ac95f6f5d4c9bb7c2fc069f029adcff7f66` |
