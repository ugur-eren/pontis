import { DepositBatch, L1TxHash, L2Address } from "../../state";
import { DepositAggregatorCovenant, DepositAggregatorState, getContractScriptPubKeys, utils } from "l1";
import { Deposit } from "../../state";
import { ByteString, PubKey, Sha256 } from "scrypt-ts"; 
import { stateHashToBatchID } from "l1";
import * as env from '../env'

export async function getContractAddresses(): Promise<{
    bridge: string;
    depositAggregator: string;
    withdrawExpander: string;
    operator: string;
}> {
    const operatorPubKey = await env.operatorSigner.getPublicKey();
    const spks = getContractScriptPubKeys(PubKey(operatorPubKey));
    const addressess =  {
        bridge: utils.p2trLockingScriptToAddr(spks.bridge, env.l1Network),
        depositAggregator: utils.p2trLockingScriptToAddr(spks.depositAggregator, env.l1Network),
        withdrawExpander: utils.p2trLockingScriptToAddr(spks.withdrawExpander, env.l1Network),
        operator: await env.operatorSigner.getAddress(),
    }
    return addressess;
}

export function l2AddressToHex(l2Address: L2Address): string {
    let hex: string = l2Address;
    if (l2Address.startsWith('0x')) {
        hex = hex.slice(2);
    }
    hex = hex.padStart(64, '0');
    return hex;
}

export function checkDepositBatch(
    deposits: Deposit[],
) {

    const depositCount = deposits.length;
    const height = getDepositBatchHeight(deposits);
    if (2 ** height !== depositCount) {
        throw new Error('deposit count is not a power of 2');
    }
}
export function getDepositBatchHeight(deposits: Deposit[]): number {
    const depositCount = deposits.length;
    const height = Math.log2(depositCount);
    return height;
}

export function getFinalizeL1Txid(depositBatch: DepositBatch): L1TxHash {
    if (
        depositBatch.status === 'FINALIZED' ||
        depositBatch.status === 'SUBMITTED_TO_L2' ||
        depositBatch.status === 'DEPOSITED' ||
        depositBatch.status === 'SUBMITTED_FOR_COMPLETION' ||
        depositBatch.status === 'COMPLETED'
    ) {
        return depositBatch.finalizeBatchTx.hash;
    }
    throw new Error('deposit batch is not finalized, status: ' + depositBatch.status);
}

export function getDepositBatchID(depositBatch: DepositBatch): ByteString {
    const l1Txid = getFinalizeL1Txid(depositBatch);
    const height = getDepositBatchHeight(depositBatch.deposits);
    const state = calculateDepositState(depositBatch.deposits, height);
    return stateHashToBatchID(Sha256(DepositAggregatorCovenant.serializeState(state[0])), l1Txid);
}

export function calculateDepositState(
    deposits: Deposit[],
    level: number,
) {
    // here verify deposits length is a power of 2, and level is smaller or equal to the height of the tree
    checkDepositBatch(deposits)
    const height = getDepositBatchHeight(deposits);
    if (level > height) {
        throw new Error('level is greater than the height of the tree');
    }

    // for level 0 state, call createDepositState
    let currentLevel = 0;
    let currentLevelStates: DepositAggregatorState[] = [];
    currentLevelStates = deposits.map(deposit => DepositAggregatorCovenant.createDepositState(
        l2AddressToHex(deposit.recipient),
        deposit.amount
    ));
    let currentLevelStateHashes: ByteString[] = currentLevelStates.map(state => DepositAggregatorCovenant.serializeState(state));
    if (level === 0) {
        return currentLevelStates;
    }

    // calculate the state for next level, until we reach the level we want
    // for level > 0, call createAggregateState, like calculate merkle tree root, we need to hash the left and right child
    while(++currentLevel <= level) {
        const nextLevelStates: DepositAggregatorState[] = [];
        const nextLevelStateHashes: ByteString[] = [];
        for (let i = 0; i < currentLevelStates.length; i += 2) {
            const left = currentLevelStateHashes[i];
            const right = currentLevelStateHashes[i + 1];
            const state = DepositAggregatorCovenant.createAggregateState(
                BigInt(currentLevel),
                Sha256(left),
                Sha256(right),
            );
            nextLevelStates.push(state);
            nextLevelStateHashes.push(DepositAggregatorCovenant.serializeState(state));
        }
        currentLevelStates = nextLevelStates;
        currentLevelStateHashes = nextLevelStateHashes;
        if (currentLevel === level) {
            return nextLevelStates;
        }
    }
    throw new Error('no reach here');
}
