import { ipcMain, IpcMainInvokeEvent } from 'electron';

import { EventEmitter } from 'events';
import { IConfirmation } from '~/interfaces/confirmation';
import {
  IWalletError,
  IWalletErrorTypes,
  IWalletEvents,
} from '~/interfaces/wallet';
import { ITxReceive, ITxSend } from '~/interfaces/tx';
import { add, fixed, gt, minus } from '~/utils/Big';
import { WalletHistory } from '~/main/fork/point/wallet/wallet-history';
import { WindowsService } from '~/main/windows-service';
import { Application } from '~/main/application';
import { invokeEvent } from '~/utils/scripts';
import { WALLET_API } from '~/constants/api';
import { Settings } from '~/main/models/settings';
import {
  IPointSettings,
  IWalletSettings,
} from '~/main/fork/point/interfaces/settings';
import axios from 'axios';
import { apiRequest } from '~/utils/api';

const testAddress = '0xC01011611e3501C6b3F6dC4B6d3FE644d21aB301';

export class WalletService extends EventEmitter {
  public address = '';
  public hash = '';
  public funds = '0';
  public requestQueue: number[] = [];
  public walletSettings: IWalletSettings;
  public txHashArr: string[] = [];

  public walletHistory: WalletHistory;
  private loaded = false;

  public constructor() {
    super();

    this.getAccountFunds();
    // TODO
    //  add listener that listens to the connected light client
    //  and updates funds and emits an event

    this.on(IWalletEvents.RECEIVED_FUNDS, (_, obj: ITxReceive) => {
      // TODO
      //  invoke notification that funds were received
      this.walletHistory.receiveTx(obj);
      this.funds = add(this.funds, obj.amount);
    });
    this.applyIpcHandlers();
  }

  public loadSettings() {
    Settings.instance.getSettings().then((settings) => {
      const pointSettings = settings.extendedSettings as IPointSettings;
      this.walletSettings = pointSettings.wallet;
      if (
        this.walletSettings.walletId === '' ||
        this.walletSettings.passcode === ''
      ) {
        this.initWallet().then(() => {
          this.loadPublicAddress();
          this.loadAccountHash();
        });
      } else {
        //  wallet is loaded
        console.log('wallet was loaded');
        this.loaded = true;
        this.loadPublicAddress();
        this.loadAccountHash();
      }
    });
  }

  public async loadPublicAddress(): Promise<void> {
    if (!this.loaded) return;
    console.log('request public address');
    const { data } = await apiRequest(WALLET_API, 'PUBLIC_KEY', {
      headers: this.headers,
    });
    if (data?.status === 200) {
      const resData = data.data as Record<string, string>;
      this.address = resData?.publicKey;
      this.emit('load');
    }
  }

  private async initWallet() {
    const { data } = await apiRequest(WALLET_API, 'GENERATE');
    const walletData = data.data as IWalletSettings;
    this.walletSettings.walletId = walletData.walletId;
    this.walletSettings.passcode = walletData.passcode;
    console.log('New Wallet generated', walletData);
    Settings.instance.updateSettings({
      extendedSettings: { wallet: this.walletSettings },
    });
    this.loaded = true;
  }

  private async loadAddress() {
    if (this.address === '') {
      await this.onAddressLoad();
    }
    return this.address;
  }

  public async loadAccountHash() {
    if (!this.loaded) return;
    const { data } = await apiRequest(WALLET_API, 'HASH', {
      headers: this.headers,
    });
    const resData = data.data as Record<string, string>;
    console.log('load account hash', resData);
    this.hash = resData.hash;
  }

  public async getAccountFunds() {
    await this.loadAddress();
    const { data } = await apiRequest(WALLET_API, 'BALANCE', {
      headers: this.headers,
    });
    if (data.status === 200) {
      const fundsData = data.data as Record<string, string>;
      console.log('got funds', fundsData);
      this.funds = fixed(fundsData.balance);
      invokeEvent('wallet-update-funds', this.funds);
    }
  }

  public async getHash() {
    await this.loadAddress();
    if (this.hash !== '') return this.hash;
    await this.loadAccountHash();
    return this.hash;
  }

  public requestSendFunds(
    confirmObj: IConfirmation,
    amount: number,
  ): IWalletError | boolean {
    if (gt(amount, this.funds))
      return createWalletError(
        IWalletErrorTypes.NOT_ENOUGH_FUNDS,
        'Not enough funds',
      );
    // TODO
    //  invoke the confirmation window
    const confirmationDialog = Application.instance.dialogs.getPersistent(
      'confirmation',
    );
    console.log('sent confirmation request');
    confirmationDialog.send('confirmation-request', confirmObj, amount);

    this.requestQueue.push(amount);
    return true;
  }

  public pushTx(hash: string) {
    this.txHashArr.push(hash);
    invokeEvent('wallet-update-txHashArr', hash);
  }

  public async sendFunds() {
    if (this.requestQueue.length === 0) return;
    const amount = this.requestQueue.shift();

    const { data } = await apiRequest(WALLET_API, 'REQUEST_TX', {
      headers: this.headers,
      body: {
        to: testAddress,
        value: `${amount}`,
      },
    });
    if (data.status === 200) {
      const resData = data.data as Record<string, string>;
      this.pushTx(resData.transactionHash);
    } else {
      alert(`tx send fail - ${JSON.stringify(data)}`);
    }

    this.getAccountFunds();
  }

  private applyIpcHandlers() {
    ipcMain.handle(
      'wallet-send-funds',
      async (
        e: IpcMainInvokeEvent,
        confirmationObj: IConfirmation,
        amount: number,
      ) => {
        this.requestSendFunds(
          { ...confirmationObj, windowId: e.frameId },
          amount,
        );
      },
    );

    ipcMain.handle(
      'wallet-confirmed-send-funds',
      async (e: IpcMainInvokeEvent) => {
        console.log('received confirmed send funds');
        this.sendFunds();
      },
    );

    ipcMain.handle(
      'wallet-rejected-send-funds',
      async (e: IpcMainInvokeEvent) => {
        this.requestQueue.shift();
      },
    );

    ipcMain.handle(`wallet-get-funds`, async () => {
      return this.funds;
    });

    ipcMain.handle(`wallet-get-address`, async () => {
      return this.address;
    });

    ipcMain.handle(`wallet-get-data`, async () => {
      return {
        funds: this.funds,
        address: this.address,
        txHashArr: this.txHashArr,
      };
    });

    ipcMain.handle(`wallet-get-confirmation-hash`, async () => {
      const hash = await this.getHash();
      return { hash };
    });
  }

  private onAddressLoad = async (): Promise<void> => {
    return new Promise((resolve) => {
      if (this.address === '') {
        this.once('load', () => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  };

  get walletKey() {
    return `${this.walletSettings.walletId}-${this.walletSettings.passcode}`;
  }

  get headers() {
    return {
      'wallet-token': this.walletKey,
    };
  }
}

export const createWalletError = (
  errorType: IWalletErrorTypes,
  message: string,
): IWalletError => {
  return {
    type: errorType,
    message,
  };
};
