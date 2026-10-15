/**
 * Which dates of a statement are out of order. A statement lists its transactions by date, so the
 * dates should only ever move one way. A read that got a month, day or year wrong shows up as a
 * block of dates that run backwards, which the running balance cannot see.
 */

/**
 * Indices of the dates that are not part of the longest run of non-decreasing dates (ISO strings).
 * Equal dates are in order. Everything outside that longest run is what disagrees with the rest.
 */
export function outOfOrderIndices(dates: string[]): number[] {
  const tails: number[] = []; // tails[k] = index of the smallest last date of any run of length k + 1
  const previous: number[] = new Array(dates.length).fill(-1);
  for (let index = 0; index < dates.length; index += 1) {
    // First run whose last date is later than this one: this date extends the run before it.
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (dates[tails[middle]] <= dates[index]) low = middle + 1;
      else high = middle;
    }
    previous[index] = low > 0 ? tails[low - 1] : -1;
    tails[low] = index;
  }
  const inOrder = new Set<number>();
  for (let index = tails.length > 0 ? tails[tails.length - 1] : -1; index >= 0; index = previous[index]) inOrder.add(index);
  const outside: number[] = [];
  for (let index = 0; index < dates.length; index += 1) if (!inOrder.has(index)) outside.push(index);
  return outside;
}
