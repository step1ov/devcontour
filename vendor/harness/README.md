# Закреплённая версия harness

Зависимость `devcontour-harness` — точная версия из npm registry; она не
вкладывается в архив DevContour. `package-lock.json` фиксирует resolved и
integrity опубликованных байтов; при закреплении integrity сверена с
проверенным архивом. Смена версии — новый выпуск DevContour:
`node scripts/pin-harness.mjs <версия> --commit <SHA> --archive <архив>`.

| Версия         | Integrity опубликованного пакета                                                                  | Исходный commit harness                    |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0.1.0-alpha.46 | `sha512-WgP8glMErckcF8y1nzAGio//1/RMJJRuZ8hFEWHcog1/YvUIwIY6KN+j5FP8egs+a8xbs4yOXG/6jimImPFg9g==` | `5c83a71027836af4318e168de065bbc3d377bdd2` |
