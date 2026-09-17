# Дизайн-контракт

1. references.md: URL/локальные артефакты и конкретные свойства, которые берём.
2. direction.md: цель, аудитория, композиция, типографика, плотность.
3. prototype: утверждённый макет и состояния loading/empty/error/success, mobile/desktop.
4. tokens: primitive → semantic → component. Цвет, шрифт, spacing, radius, elevation, motion, breakpoints.
5. guidelines.md: компоненты, состояния, accessibility, примеры допустимого использования.
6. Привязать утверждённую версию к Task.contracts. Затем functional + visual regression.

В качестве рабочего примера смотрите design/direction.md и src/web/tokens.css самого шаблона DevContour. Значения существуют в каноническом источнике; компоненты не дублируют их.
