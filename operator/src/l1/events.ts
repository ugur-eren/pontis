import {
  distinctUntilChanged,
  from,
  map,
  interval,
  Observable,
  switchMap,
  scan,
  timer,
  filter,
} from 'rxjs';
import { BlockNumberEvent, Deposit, Deposits } from '../state';
import * as l1Api from './api';

const POLL_INTERVAL = 5000;

export function l1BlockNumber(): Observable<BlockNumberEvent> {
  return currentBlock().pipe(
    map((blockNumber) => ({ type: 'l1BlockNumber', blockNumber }))
  );
}

function currentBlock(): Observable<number> {
  return timer(0, POLL_INTERVAL).pipe(
    switchMap(() => from(getCurrentL1BlockNumber())),
    distinctUntilChanged()
  );
}

export function currentBlockRange(
  initialBlockNumber: number
): Observable<[number, number]> {
  return currentBlock().pipe(
    scan(
      ([_, previous], current) => [previous + 1, current],
      [0, initialBlockNumber]
    )
  );
}

export function deposits(initialBlockNumber: number): Observable<Deposits> {
  return currentBlockRange(initialBlockNumber).pipe(
    switchMap(([previous, current]) =>
      from(depositsInRange(previous, current))
    ),
    filter((deposits) => deposits.length > 0),
    map((deposits) => ({ type: 'deposits', deposits }))
  );
}

async function getCurrentL1BlockNumber(): Promise<number> {
  return l1Api.getL1CurrentBlockNumber();
}

async function depositsInRange(
  blockFrom: number,
  blockTo: number
): Promise<Deposit[]> {
  const deposits = await  l1Api.listDeposits(blockFrom, blockTo);
  // console.log('deposits', blockFrom, blockTo, deposits)
  return deposits
}
