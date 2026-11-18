/**
 * Сократить текст до `n` знаков по границе фразы или слова, с «…».
 *
 * История операции хранится в записи и ограничена по размеру, но обрыв
 * посреди слова делал причину отказа нечитаемой. Граница предложения берётся,
 * если она не дальше трети предела от конца, иначе — последний пробел.
 * Полный текст ревью доступен по ссылке `review` записи истории.
 */
export function clipAtBoundary(text: string, n: number) {
  if (text.length <= n) return text;
  // Не разрезать суррогатную пару: половина символа в JSON — мусор.
  let end = n - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  const head = text.slice(0, end);
  const sentence = Math.max(...['. ', '; ', '! ', '? ', '.\n'].map((m) => head.lastIndexOf(m)));
  const space = head.search(/\s\S*$/);
  const cut = sentence >= (n * 2) / 3 ? sentence + 1 : space > n / 3 ? space : head.length;
  return head.slice(0, cut).trimEnd() + '…';
}
