// Таксономия отказов и правила починки — договор пакета harness.
//
// Класс отказа ставится в точке, где отказ обнаружен, записывается вместе с
// попыткой и дальше используется как есть: восстанавливать его регулярным
// выражением по тексту значит угадывать. Определения живут в harness;
// DevContour их не дублирует.
export {
  TaskFailure,
  failureFingerprint,
  failureKinds,
  repairPolicy,
  type FailureKind,
  type RepairRule,
} from 'devcontour-harness/contracts';
