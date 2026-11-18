# Закреплённая версия harness

Зависимость `devcontour-harness` — точная версия из npm registry; она не
вкладывается в архив DevContour. `package-lock.json` фиксирует resolved и
integrity опубликованных байтов; при закреплении integrity сверена с
проверенным архивом. Смена версии — новый выпуск DevContour:
`node scripts/pin-harness.mjs <версия> --commit <SHA> --archive <архив>`.

| Версия         | Integrity опубликованного пакета                                                                  | Исходный commit harness                    |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0.1.0-alpha.48 | `sha512-INKHaChVG93icD9sVtKRSDHTieEbWZXQqr2SN+BXCM1sKabKlMyVxnOWyoMBlO7jSSI0JnEBc9dzq2jkZ56y+w==` | `8f612f702937632184e3a49115d9e61ed8aa3286` |
