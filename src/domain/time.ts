/**
 * 时间格式校验与格式化（SPEC §11.5）。
 *
 * 时间点由 Application 注入的 ClockPort 提供；本模块只负责 RFC 3339
 * 契约以及“使用当前操作系统时区偏移量”的统一序列化规则。
 */

/** RFC 3339 时间，必须显式携带 `Z` 或数值时区偏移量。 */
export const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const RFC3339_GROUPS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * 校验完整 RFC 3339 时间，同时拒绝不存在的日历日期和越界偏移量。
 *
 * 这里按文本中的本地日历分量校验，不把带偏移时间先转换为 UTC，
 * 避免跨日转换后误判原始日期。
 */
export function isRfc3339(value: string): boolean {
  const match = RFC3339_GROUPS.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

/**
 * 把 Date 格式化为当前操作系统时区下的 RFC 3339 时间。
 *
 * 所有程序生成的时间戳都必须经过此唯一入口，输出固定为
 * `YYYY-MM-DDTHH:mm:ss.sss±HH:mm`；无效 Date 或超出四位年份时抛出
 * RangeError。
 */
export function formatRfc3339InSystemTimeZone(date: Date): string {
  const time = date.getTime();
  const year = date.getFullYear();
  if (Number.isNaN(time) || year < 0 || year > 9999) {
    throw new RangeError('Date cannot be represented as RFC 3339');
  }

  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  const offsetMinutes = date.getTimezoneOffset();
  const offsetSign = offsetMinutes <= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHour = Math.floor(absoluteOffset / 60);
  const offsetMinute = absoluteOffset % 60;

  return (
    `${pad(year, 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${offsetSign}${pad(offsetHour)}:${pad(offsetMinute)}`
  );
}
