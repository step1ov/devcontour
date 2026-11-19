# Закреплённая версия harness

Зависимость `devcontour-harness` — точная версия из npm registry; она не
вкладывается в архив DevContour. `package-lock.json` фиксирует resolved и
integrity опубликованных байтов; при закреплении integrity сверена с
проверенным архивом. Смена версии — новый выпуск DevContour:
`node scripts/pin-harness.mjs <версия> --commit <SHA> --archive <архив>`.

| Версия         | Integrity опубликованного пакета                                                                  | Исходный commit harness                    |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0.1.0-alpha.55 | `sha512-a5w2q9Lv8obNAtDapTkq+h08BdSyhCI7yOTTTAGeun/TKmcTX1xKdjVIdPzqgApVagXN94t8yoUyiQRLonfgfQ==` | `24d28d736b9fda75730f73f6da035ea997ba997a` |
