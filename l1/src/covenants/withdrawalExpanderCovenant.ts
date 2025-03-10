import { ByteString, PubKey, Sha256 } from 'scrypt-ts'
import { Covenant } from '../lib/covenant'
import { SupportedNetwork } from '../lib/constants'
import {
  ExpanderTransaction,
  WithdrawalExpander,
} from '../contracts/withdrawalExpander'
import { InputCtx, SubContractCall } from '../lib/extPsbt'
import {
  createEmptySha256,
  inputsToSegmentByteString,
  isTxHashEqual,
  locktimeToByteString,
  ONE_STATE_OUTPUT_SCRIPT_LENGTH,
  outputToByteString,
  splitHashFromStateOutput,
  versionToByteString,
} from '../lib/txTools'
import { ChainProvider, WithdrawalExpanderUtxo } from '../lib/provider'
import { Transaction } from '@scrypt-inc/bitcoinjs-lib'
import * as tools from 'uint8array-tools'
import { toXOnly } from '../lib/utils'
import { CONTRACT_INDEXES, getChangeOutput } from './util'

export type WithdrawalExpanderState = {
  type: 'LEAF',
  withdrawAddressScript: ByteString,
  withdrawAmt: bigint,
} | {
  type: 'INTERNAL',
  leftAmt: bigint,
  rightAmt: bigint,
  leftChildRootHash: Sha256,
  rightChildRootHash: Sha256,
}

export interface TraceableWithdrawalExpanderUtxo
  extends WithdrawalExpanderUtxo {
  operator: PubKey
}

export type TracedWithdrawalExpander = {
  covenant: WithdrawalExpanderCovenant
  trace: {
    prevTx: ExpanderTransaction
  }
  rawtx: {
    prevTx: string
  }
}

export class WithdrawalExpanderCovenant extends Covenant<WithdrawalExpanderState> {
  static readonly LOCKED_ASM_VERSION = '7f803a78b195e19c392c53a29eca9f0e'
  static readonly MAX_LEVEL_FOR_DISTRIBUTE = 2n;
  
  constructor(
    readonly operator: PubKey,
    state: WithdrawalExpanderState,
    network?: SupportedNetwork
  ) {
    super(
      [
        {
          contract: new WithdrawalExpander(PubKey(toXOnly(operator, true))),
          // contract: new WithdrawalExpander(operator),
        },
      ],
      {
        lockedAsmVersion: WithdrawalExpanderCovenant.LOCKED_ASM_VERSION,
        network: network,
      }
    )
    this.state = state
  }

  distribute(
    inputIndex: number,
    inputCtxs: Map<number, InputCtx>,

    isFirstExpanderOutput: boolean,

    prevTx: ExpanderTransaction,

    withdrawalAddresses: Array<ByteString>,
    withdrawalAmts: Array<bigint>,

    fundingPrevout: ByteString
  ): SubContractCall {
    if (withdrawalAddresses.length !== 4) {
      throw new Error('withdrawalAddresses length should be 4')
    }
    if (withdrawalAmts.length !== 4) {
      throw new Error('withdrawalAmts length should be 4')
    }

    const subCall: SubContractCall = {
      method: 'distribute',
      argsBuilder: (self, _tapLeafContract) => {
        const { shPreimage } = inputCtxs.get(inputIndex)
        if (!shPreimage) {
          throw new Error('Input context is not available')
        }
        return [
          shPreimage,
          () => {
            return self.getSig(inputIndex, {
              publicKey: this.operator.toString(),
            })
          },

          isFirstExpanderOutput,

          prevTx,

          withdrawalAddresses,
          withdrawalAmts,

          fundingPrevout,
          self.getChangeOutput(),
        ]
      },
    }
    return subCall
  }

  expand(
    inputIndex: number,
    inputCtxs: Map<number, InputCtx>,

    isFirstExpanderOutput: boolean,

    prevTx: ExpanderTransaction,

    fundingPrevout: ByteString
  ): SubContractCall {
    const state = this.state!
    const subCall: SubContractCall = {
      method: 'expand',
      argsBuilder: (self, _tapLeafContract) => {
        const { shPreimage } = inputCtxs.get(inputIndex)
        if (!shPreimage) {
          throw new Error('Input context is not available')
        }
        if (state.type === 'LEAF') {
          throw new Error('leaf state cannot be expanded')
        }

        return [
          shPreimage,
          () => {
            return self.getSig(inputIndex, {
              publicKey: this.operator.toString(),
            })
          },

          isFirstExpanderOutput,

          prevTx,

          state.leftChildRootHash,
          state.rightChildRootHash,

          state.leftAmt,
          state.rightAmt,

          fundingPrevout,
          self.getChangeOutput(),
        ]
      },
    }
    return subCall
  }

  static async backtrace(
    utxo: TraceableWithdrawalExpanderUtxo,
    chainProvider: ChainProvider
  ): Promise<TracedWithdrawalExpander> {
    const covenant = new WithdrawalExpanderCovenant(utxo.operator, utxo.state)
    if (utxo.utxo.script !== covenant.lockingScriptHex) {
      throw new Error('invalid withdrawal expander utxo')
    }

    const prevRawtx = await chainProvider.getRawTransaction(utxo.utxo.txId)
    const prevTx = Transaction.fromHex(prevRawtx)

    const prevTxInContract =
      WithdrawalExpanderCovenant.getExpanderTransaction(prevTx)
    const txid = WithdrawalExpander.getTxId(prevTxInContract)
    if (!isTxHashEqual(prevTx, txid)) {
      throw new Error('txid mismatch')
    }

    return {
      covenant,
      trace: {
        prevTx: prevTxInContract,
      },
      rawtx: {
        prevTx: prevRawtx,
      },
    }
  }

  private static getExpanderTransaction(tx: Transaction): ExpanderTransaction {
    const isSingleExpanderOutput =
      tx.outs[0].script.length === ONE_STATE_OUTPUT_SCRIPT_LENGTH
    let isCreateWithdrawalTx = false
    if (!isSingleExpanderOutput) {
      isCreateWithdrawalTx =
        tools.compare(tx.outs[1].script, tx.outs[2].script) != 0
    }

    let bridgeSPK = ''
    let bridgeAmt = 0n
    let bridgeStateHash = createEmptySha256()
    if (isCreateWithdrawalTx) {
      bridgeSPK = tools.toHex(tx.outs[CONTRACT_INDEXES.outputIndex.bridge].script)
      bridgeAmt = tx.outs[CONTRACT_INDEXES.outputIndex.bridge].value
      bridgeStateHash = Sha256(splitHashFromStateOutput(tx)[0])
    }

    const contractSPK = isCreateWithdrawalTx
      ? tools.toHex(tx.outs[CONTRACT_INDEXES.outputIndex.withdrawalExpander.inBridgeTx].script)
      : tools.toHex(tx.outs[CONTRACT_INDEXES.outputIndex.withdrawalExpander.inDepositAggregatorTx.first].script)
    const output0Amt = isCreateWithdrawalTx
      ? tx.outs[CONTRACT_INDEXES.outputIndex.withdrawalExpander.inBridgeTx].value
      : tx.outs[CONTRACT_INDEXES.outputIndex.withdrawalExpander.inDepositAggregatorTx.first].value
    const stateHash0 = isCreateWithdrawalTx
      ? Sha256(splitHashFromStateOutput(tx)[1])
      : Sha256(splitHashFromStateOutput(tx)[0])

    let output1Amt = 0n
    let stateHash1 = createEmptySha256()
    if (!isCreateWithdrawalTx && !isSingleExpanderOutput) {
      output1Amt = tx.outs[CONTRACT_INDEXES.outputIndex.withdrawalExpander.inDepositAggregatorTx.second].value
      stateHash1 = Sha256(splitHashFromStateOutput(tx)[1])
    }

    let changeOutput = getChangeOutput(tx, [contractSPK, bridgeSPK])

    const res = {
      ver: versionToByteString(tx),
      inputs: inputsToSegmentByteString(tx),

      isCreateWithdrawalTx,

      bridgeSPK,
      bridgeAmt,
      bridgeStateHash,

      contractSPK,
      output0Amt,
      stateHash0,

      output1Amt,
      stateHash1,

      changeOutput,
      locktime: locktimeToByteString(tx),
    }
    return res
  }

  serializedState() {
    return WithdrawalExpanderCovenant.serializeState(this.state)
  }

  static serializeState(state: WithdrawalExpanderState) {
    if (state.type === 'LEAF') {
      return WithdrawalExpander.getLeafNodeHash(
        state.withdrawAddressScript,
        state.withdrawAmt 
      )
    } else {
      return WithdrawalExpander.getBranchNodeHash(
        state.leftAmt,
        state.leftChildRootHash,
        state.rightAmt,
        state.rightChildRootHash
      )
    }
  }

  static createNonLeafState(
    leftChildRootHash: Sha256,
    rightChildRootHash: Sha256,
    leftAmt: bigint,
    rightAmt: bigint
  ): WithdrawalExpanderState {
    return {
      type: 'INTERNAL',
      leftChildRootHash,
      rightChildRootHash,
      leftAmt,
      rightAmt,
    }
  }

  static createLeafState(
    withdrawAddressScript: ByteString,
    withdrawAmt: bigint
  ): WithdrawalExpanderState {
    return {
      type: 'LEAF',
      withdrawAddressScript,
      withdrawAmt,
    }
  }

  static createEmptyState(): WithdrawalExpanderState {
    return this.createLeafState('', 0n)
  }
}
