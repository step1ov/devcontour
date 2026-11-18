# Закреплённая версия harness

Зависимость `devcontour-harness` — точная версия из npm registry; она не
вкладывается в архив DevContour. `package-lock.json` фиксирует resolved и
integrity опубликованных байтов; при закреплении integrity сверена с
проверенным архивом. Смена версии — новый выпуск DevContour:
`node scripts/pin-harness.mjs <версия> --commit <SHA> --archive <архив>`.

| Версия         | Integrity опубликованного пакета                                                                  | Исходный commit harness                    |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0.1.0-alpha.49 | `sha512-K3RxgPpZ/XsH+X9rRNkiEjOiqi0+kvjX+HIHsy8G+NfLzUDbp3NSF0swg0WsGPRX21bSOT5BUpjxMZdn7HSXlw==` | `4d6fa342dde98deb66de387a6d6240ffefd89d48` |
