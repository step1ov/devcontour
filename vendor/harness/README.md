# Закреплённая версия harness

Зависимость `devcontour-harness` — точная версия из npm registry; она не
вкладывается в архив DevContour. `package-lock.json` фиксирует resolved и
integrity опубликованных байтов; при закреплении integrity сверена с
проверенным архивом. Смена версии — новый выпуск DevContour:
`node scripts/pin-harness.mjs <версия> --commit <SHA> --archive <архив>`.

| Версия         | Integrity опубликованного пакета                                                                  | Исходный commit harness                    |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0.1.0-alpha.44 | `sha512-SdKXvIGFJVilKYk7bWuaXdoYQ8+Tyi2FlAsiPYk1RSDGbvpkqFNqF4PjpQ99HuARer7+ojgyEEXyjY1f0wKVuQ==` | `0aa2775b8f094f66bf78c2116202a5585c512d16` |
