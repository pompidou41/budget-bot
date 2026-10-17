import { describe, expect, it } from 'vitest';
import { isoToSerial } from '../src/domain/dates.js';
import { findLastDay, parseEntry, renderLastDay } from '../src/domain/last.js';
import { ref } from './fixtures.js';

const TODAY = '2026-10-17';
const HEADER = ['Дата', 'Тип', 'Счёт', 'Сумма', 'Счёт куда', 'Получено', 'Категория'];

/** «Добавлено» as the bot writes it: a date-time serial. */
function at(iso: string, hour: number, minute = 0): number {
  return isoToSerial(iso) + (hour * 60 + minute) / 1440;
}

/** A row of «Операции»!A:L as Sheets returns it with UNFORMATTED_VALUE. */
function row(
  date: string,
  comment: string,
  addedAt: number | '' = '',
  extra: { type?: string; account?: string; amount?: number; to?: string; received?: number } = {},
): unknown[] {
  return [
    isoToSerial(date),
    extra.type ?? 'Расход',
    extra.account ?? 'T_MAIN',
    extra.amount ?? 300,
    extra.to ?? '',
    extra.received ?? '',
    'Food',
    'Groceries',
    comment,
    false,
    '',
    addedAt,
  ];
}

describe('findLastDay', () => {
  it('goes by the date of the operation, not by when it was entered', () => {
    // All three entered on the 17th; the tea is the latest by its own date
    const rows = [
      HEADER,
      row('2026-10-10', 'кофе', at(TODAY, 10, 0)),
      row('2026-10-16', 'чай', at(TODAY, 10, 1)),
      row('2026-10-08', 'печенье', at(TODAY, 10, 2)),
    ];

    const { day } = findLastDay(rows, TODAY);

    expect(day?.date).toBe('2026-10-16');
    expect(day?.entries.map((entry) => entry.op.comment)).toEqual(['чай']);
    expect(day?.entries[0]?.row).toBe(3);
  });

  it('orders one day by «Добавлено», not by row: the bot reuses rows freed by /undo', () => {
    const rows = [
      HEADER,
      row('2026-10-16', 'вписан последним в пустую строку', at(TODAY, 12)),
      row('2026-10-16', 'первый', at(TODAY, 10)),
      row('2026-10-16', 'второй', at(TODAY, 11)),
    ];

    const entries = findLastDay(rows, TODAY).day?.entries ?? [];

    expect(entries.map((entry) => entry.op.comment)).toEqual([
      'первый',
      'второй',
      'вписан последним в пустую строку',
    ]);
  });

  it('takes a row without «Добавлено» as entered at the start of its date, then goes by row', () => {
    const rows = [
      HEADER,
      row('2026-10-16', 'бот', at(TODAY, 9)),
      row('2026-10-16', 'вручную, выше'),
      row('2026-10-16', 'перенесён миграцией', isoToSerial('2026-10-16')),
    ];

    const entries = findLastDay(rows, TODAY).day?.entries ?? [];

    expect(entries.map((entry) => entry.op.comment)).toEqual([
      'вручную, выше',
      'перенесён миграцией',
      'бот',
    ]);
  });

  it('skips the header, blanks, ARCHIVE rows and rows without a known type', () => {
    const rows = [
      HEADER,
      [],
      ['', '', '', '', '', '', '', '', '', false],
      row('2026-10-17', 'архив', '', { account: 'ARCHIVE' }),
      row('2026-10-17', 'непонятно', '', { type: 'Списание' }),
      row('2026-10-15', 'настоящая'),
    ];

    const { day } = findLastDay(rows, TODAY);

    expect(day?.date).toBe('2026-10-15');
    expect(day?.entries.map((entry) => entry.op.comment)).toEqual(['настоящая']);
  });

  it('leaves operations dated after today out and only counts them', () => {
    const rows = [
      HEADER,
      row('2026-11-05', 'аренда наперёд'),
      row('2026-10-17', 'сегодня'),
      row('2026-10-20', 'опечатка в дате'),
    ];

    const result = findLastDay(rows, TODAY);

    expect(result.day?.date).toBe(TODAY);
    expect(result.future).toEqual({ count: 2, latest: '2026-11-05' });
  });

  it('has no day when nothing is dated today or earlier', () => {
    expect(findLastDay([HEADER], TODAY)).toEqual({ day: null, future: null });
    expect(findLastDay([HEADER, row('2026-10-20', 'потом')], TODAY).day).toBeNull();
  });
});

describe('parseEntry', () => {
  it('reads a transfer with everything the card shows', () => {
    const cells = row('2026-10-12', 'себе', at('2026-10-17', 9), {
      type: 'Перевод',
      amount: 40000,
      to: 'HEL_MAIN',
      received: 410,
    });

    expect(parseEntry(cells, 7)).toMatchObject({
      row: 7,
      op: {
        type: 'Перевод',
        account: 'T_MAIN',
        amount: 40000,
        toAccount: 'HEL_MAIN',
        received: 410,
      },
    });
  });
});

describe('renderLastDay', () => {
  it('shows the date, the newest operation as a card and the rest of the day as lines', () => {
    const rows = [
      HEADER,
      row('2026-10-16', 'Пятёрочка', at(TODAY, 10)),
      row('2026-10-16', 'себе', at(TODAY, 10, 5), {
        type: 'Перевод',
        amount: 40000,
        to: 'HEL_MAIN',
        received: 410,
      }),
      row('2026-10-16', 'чай', at(TODAY, 14, 32), { amount: 350 }),
    ];

    const html = renderLastDay(findLastDay(rows, TODAY), ref);

    expect(html).toContain('📍 Последняя дата: <b>16.10.2026 (пт)</b>');
    expect(html).toContain('💬 чай');
    expect(html).toContain('💰 350 RUB');
    expect(html).toContain(
      '<i>Внесена последней из 3 за этот день · строка 4 · добавлена 17.10 14:32</i>',
    );
    expect(html).toContain('<b>Ещё за 16.10:</b>\n📉 300 RUB · T_MAIN · Пятёрочка\n🔁 40');
    expect(html).toContain('RUB · T_MAIN → HEL_MAIN · себе');
    expect(html).not.toContain('⏭');
  });

  it('shows no time for a row whose «Добавлено» the migration filled with the bare date', () => {
    const rows = [HEADER, row('2026-10-12', 'Бензин', isoToSerial('2026-10-12'))];

    const html = renderLastDay(findLastDay(rows, TODAY), ref);

    expect(html).toContain('<i>Единственная за этот день · строка 2</i>');
    expect(html).not.toContain('Ещё за');
  });

  it('escapes and shortens what goes into the lines', () => {
    const long = 'Перевод Shamsudin M. (Себе. Перевод собственных средств.)';
    const rows = [
      HEADER,
      row('2026-10-12', long, at(TODAY, 9)),
      row('2026-10-12', '<b>', at(TODAY, 10)),
      row('2026-10-12', 'последняя', at(TODAY, 11)),
    ];

    const html = renderLastDay(findLastDay(rows, TODAY), ref);

    expect(html).toContain('· Перевод Shamsudin M. (Себе. Перевод соб…');
    expect(html).toContain('· &lt;b&gt;');
  });

  it('keeps the entries nearest to the newest when the day is long', () => {
    const rows = [
      HEADER,
      ...Array.from({ length: 25 }, (_, i) => row('2026-10-12', `№${i + 1}`, at(TODAY, 0, i + 1))),
    ];

    const html = renderLastDay(findLastDay(rows, TODAY), ref);

    expect(html).toContain('<i>…и ещё 4 внесены раньше</i>\n📉 300 RUB · T_MAIN · №5');
    expect(html).not.toContain('· №4\n');
    expect(html).toContain('💬 №25');
  });

  it('says how many operations are dated after today', () => {
    const one = findLastDay([HEADER, row('2026-10-16', 'чай'), row('2026-11-05', 'аренда')], TODAY);
    const many = findLastDay(
      [
        HEADER,
        ...['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'].map((d) =>
          row(d, 'x'),
        ),
      ],
      TODAY,
    );

    expect(renderLastDay(one, ref)).toContain(
      '⏭ С датой позже сегодняшней: 1 операция, последняя — 05.11.2026. Здесь их не учитываю.',
    );
    const html = renderLastDay(many, ref);
    expect(html).toContain('В «Операциях» нет записей с датой не позже сегодняшней.');
    expect(html).toContain('5 операций, последняя — 24.10.2026');
  });
});
