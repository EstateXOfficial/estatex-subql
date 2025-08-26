// Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Inject, Injectable } from '@nestjs/common';
import { isCustomDs, isRuntimeDs } from '@subql/common-substrate';
import {
  DatasourceParams,
  Header,
  IBlock,
  IBlockchainService,
  mainThreadOnly,
} from '@subql/node-core';
import {
  SubstrateCustomDatasource,
  SubstrateCustomHandler,
  SubstrateDatasource,
  SubstrateHandlerKind,
  SubstrateMapping,
} from '@subql/types';
import {
  SubqueryProject,
  SubstrateProjectDs,
} from './configure/SubqueryProject';
import { ApiService } from './indexer/api.service';
import { RuntimeService } from './indexer/runtime/runtimeService';
import {
  ApiAt,
  BlockContent,
  getBlockSize,
  isFullBlock,
  LightBlockContent,
} from './indexer/types';
import { IIndexerWorker } from './indexer/worker/worker';
import {
  calcInterval,
  getBlockByHeight,
  getTimestamp,
  getHeaderForHash,
  getProviderEndpoint,
  createEmptyRuntimeVersion,
} from './utils/substrate';
import { RuntimeVersion } from '@polkadot/types/interfaces';

const BLOCK_TIME_VARIANCE = 5000; //ms
const INTERVAL_PERCENT = 0.9;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: packageVersion } = require('../package.json');

@Injectable()
export class BlockchainService
  implements
    IBlockchainService<
      SubstrateDatasource,
      SubstrateCustomDatasource<
        string,
        SubstrateMapping<SubstrateCustomHandler>
      >,
      SubqueryProject,
      ApiAt,
      LightBlockContent,
      BlockContent,
      IIndexerWorker
    >
{
  constructor(
    @Inject('APIService') private apiService: ApiService,
    @Inject('RuntimeService') private runtimeService: RuntimeService,
  ) {}

  isCustomDs = isCustomDs;
  isRuntimeDs = isRuntimeDs;
  blockHandlerKind = SubstrateHandlerKind.Block;
  packageVersion = packageVersion;

  @mainThreadOnly()
  async fetchBlocks(
    blockNums: number[],
  ): Promise<IBlock<BlockContent>[] | IBlock<LightBlockContent>[]> {
    const specChanged = await this.runtimeService.specChanged(
      blockNums[blockNums.length - 1],
    );

    // If specVersion not changed, a known overallSpecVer will be pass in
    // Otherwise use api to fetch runtimes
    return this.apiService.fetchBlocks(
      blockNums,
      specChanged ? undefined : this.runtimeService.parentSpecVersion,
    );
  }

  async fetchBlockWorker(
    worker: IIndexerWorker,
    height: number,
    context: { workers: IIndexerWorker[] },
  ): Promise<Header> {
    // get SpecVersion from main runtime service
    const { blockSpecVersion, syncedDictionary } =
      await this.runtimeService.getSpecVersion(height);

    // if main runtime specVersion has been updated, then sync with all workers specVersion map, and lastFinalizedBlock
    if (syncedDictionary) {
      context.workers.map((w) =>
        w.syncRuntimeService(
          this.runtimeService.specVersionMap,
          this.runtimeService.latestFinalizedHeight,
        ),
      );
    }

    // const start = new Date();
    return worker.fetchBlock(height, blockSpecVersion);
  }

  async onProjectChange(project: SubqueryProject): Promise<void> {
    // Only network with chainTypes require to reload
    await this.apiService.updateChainTypes();
    this.apiService.updateBlockFetching();
  }

  async getBlockTimestamp(height: number): Promise<Date> {
    const block = await getBlockByHeight(this.apiService.api, height);

    let timestamp = getTimestamp(block);
    if (!timestamp) {
      // Not all networks have a block timestamp, e.g. Shiden
      const blockTimestamp = await (
        await this.apiService.unsafeApi.at(block.hash)
      ).query.timestamp.now();

      timestamp = new Date(blockTimestamp.toNumber());
    }

    return timestamp;
  }

  getBlockSize(block: IBlock): number {
    return getBlockSize(block);
  }

  async getFinalizedHeader(): Promise<Header> {
    if (this.apiService.isArchive) {
      const finalizedHash =
        await this.apiService.unsafeApi.rpc.chain.getFinalizedHead();

      return this.getHeaderForHash(finalizedHash.toHex());
    } else {
      const endpoint = getProviderEndpoint(this.apiService.unsafeApi);
      if (!endpoint) {
        throw new Error('Provider endpoint not found from unsafeApi');
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'chain_getFinalizedHead',
          params: [],
        }),
      });
      if (!res.ok) {
        throw new Error(`Network error: ${res.status} ${res.statusText}`);
      }

      const { result: finalizedHash } = (await res.json()) as { result: string };
      if (!finalizedHash) {
        throw new Error('chain_getFinalizedHead returned empty hash');
      }

      return this.getHeaderForHashRPC(finalizedHash);
    }
  }

  async getBestHeight(): Promise<number> {
    const bestHeader = await this.apiService.unsafeApi.rpc.chain.getHeader();
    return bestHeader.number.toNumber();
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async getChainInterval(): Promise<number> {
    const chainInterval = calcInterval(this.apiService.unsafeApi)
      .muln(INTERVAL_PERCENT)
      .toNumber();

    return Math.min(BLOCK_TIME_VARIANCE, chainInterval);
  }

  // TODO can this decorator be in unfinalizedBlocks Service?
  @mainThreadOnly()
  async getHeaderForHash(hash: string): Promise<Header> {
    return getHeaderForHash(this.apiService.unsafeApi, hash);
  }

  @mainThreadOnly()
  async getHeaderForHashRPC(hash: string): Promise<Header> {
    const endpoint = getProviderEndpoint(this.apiService.unsafeApi);
    if (!endpoint) {
      throw new Error('Provider endpoint not found from unsafeApi');
    }
    
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'chain_getBlock',
        params: [hash],
      }),
    });
    if (!res.ok) {
      throw new Error(`Network error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { result?: { block: any } };
    if (!data.result?.block) {
      throw new Error(`chain_getBlock returned empty block for hash ${hash}`);
    }

    const header = data.result.block.header;
    return {
      blockHeight: parseInt(header.number, 16),
      blockHash: header.hash,
      parentHash: header.parentHash,
      timestamp: new Date(0),
    };
  }

  // TODO can this decorator be in unfinalizedBlocks Service?
  @mainThreadOnly()
  async getHeaderForHeight(height: number): Promise<Header> {
    const hash = await this.apiService.unsafeApi.rpc.chain.getBlockHash(height);
    return this.getHeaderForHash(hash.toHex());
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async updateDynamicDs(
    params: DatasourceParams,
    dsObj: SubstrateProjectDs,
  ): Promise<void> {
    if (isCustomDs(dsObj)) {
      dsObj.processor.options = {
        ...dsObj.processor.options,
        ...params.args,
      };
      // TODO needs dsProcessorService
      // await this.dsProcessorService.validateCustomDs([dsObj]);
    } else if (isRuntimeDs(dsObj)) {
      // XXX add any modifications to the ds here
    }
  }

  async getSafeApi(block: LightBlockContent | BlockContent): Promise<ApiAt> {
    let runtimeVersion : RuntimeVersion | undefined;
    
    if (this.apiService.isArchive) {
      runtimeVersion = !isFullBlock(block)
        ? undefined
        : await this.runtimeService.getRuntimeVersion(block.block);
    } else {
      runtimeVersion = createEmptyRuntimeVersion(this.apiService.api.registry);
    }

    return this.apiService.getPatchedApi(
      block.block.block.header,
      runtimeVersion,
    );
  }
}
