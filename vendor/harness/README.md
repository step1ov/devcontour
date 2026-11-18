# Закреплённая версия harness

Зависимость `devcontour-harness` — точная версия из npm registry; она не
вкладывается в архив DevContour. `package-lock.json` фиксирует resolved и
integrity опубликованных байтов; при закреплении integrity сверена с
проверенным архивом. Смена версии — новый выпуск DevContour:
`node scripts/pin-harness.mjs <версия> --commit <SHA> --archive <архив>`.

| Версия         | Integrity опубликованного пакета                                                                  | Исходный commit harness                    |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0.1.0-alpha.50 | `sha512-G1VxtxWeMpnIXUMVC028UlOLA2qE7WAXZQKi5ycKsCuSlS7Xj8gGmIm3N/2eIMQ7JflYYJ6aGuO4+NWK7i6uKw==` | `64fa64e79d1cbe2159df8b9556bbd2358d3ac980` |
