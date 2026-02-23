/**
 * Bankrbot API Client
 * HTTP client for interacting with Bankrbot agent API
 */

import { BANKR_API_URL } from '../config/constants.js';
import { getClearSignPrompt, type ClearSignResult } from '../tools/get-clear-sign-prompt.js';

// Types for Bankrbot API
export interface BankrPromptRequest {
  prompt: string;
  chainId?: number;
  address?: string;
}

export interface BankrJobStatus {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: BankrTransactionResult;
  response?: string;  // Text response from agent
  error?: string;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  processingTime?: number;
}

export interface BankrTransactionResult {
  to: string;
  data: string;
  value: string;
  chainId: number;
  description?: string;
}

export interface BankrError {
  error: string;
  code?: string;
  details?: string;
}

/**
 * Bankrbot API client for transaction generation
 */
class BankrbotClient {
  private apiKey: string | undefined;
  private baseUrl: string;
  private defaultTimeout = 30000; // 30s per request
  private pollInterval = 3000; // 3s between polls
  private maxPollAttempts = 40; // Max 120s total wait (Bankrbot can take ~70s)

  constructor() {
    this.apiKey = process.env.BANKR_API_KEY;
    this.baseUrl = BANKR_API_URL;
  }

  /**
   * Check if API key is configured
   */
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Submit a natural language prompt to Bankrbot
   * @param prompt Natural language transaction request (e.g., "swap $10 of ETH to USDC on base")
   * @param chainId Optional chain ID (default: Base 8453)
   * @param userAddress Optional user address for personalized transactions
   * @returns Job ID for polling
   */
  async submitPrompt(
    prompt: string,
    chainId: number = 8453,
    userAddress?: string
  ): Promise<{ jobId: string }> {
    this.ensureConfigured();

    const response = await fetch(`${this.baseUrl}/agent/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        prompt,
        chainId,
        address: userAddress
      } as BankrPromptRequest),
      signal: AbortSignal.timeout(this.defaultTimeout)
    });

    if (!response.ok) {
      const error = await this.parseError(response);
      throw new Error(`Bankrbot API error: ${error.error}`);
    }

    const result = await response.json() as { jobId: string };
    return { jobId: result.jobId };
  }

  /**
   * Get job status
   * @param jobId Job ID from submitPrompt
   * @returns Job status with optional result
   */
  async getJobStatus(jobId: string): Promise<BankrJobStatus> {
    this.ensureConfigured();

    const response = await fetch(`${this.baseUrl}/agent/job/${jobId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`
      },
      signal: AbortSignal.timeout(this.defaultTimeout)
    });

    if (!response.ok) {
      const error = await this.parseError(response);
      throw new Error(`Bankrbot API error: ${error.error}`);
    }

    return response.json() as Promise<BankrJobStatus>;
  }

  /**
   * Submit prompt and wait for transaction result
   * @param prompt Natural language transaction request
   * @param chainId Chain ID (default: Base 8453)
   * @param userAddress Optional user address
   * @returns Transaction payload when complete
   */
  async getTransaction(
    prompt: string,
    chainId: number = 8453,
    userAddress?: string
  ): Promise<BankrTransactionResult> {
    // Submit prompt
    const { jobId } = await this.submitPrompt(prompt, chainId, userAddress);

    // Poll for completion
    let attempts = 0;
    while (attempts < this.maxPollAttempts) {
      const status = await this.getJobStatus(jobId);

      if (status.status === 'completed') {
        if (status.result) {
          return status.result;
        }
        // Completed but no transaction - likely a text response
        if (status.response) {
          throw new Error(`Bankrbot returned message instead of transaction: ${status.response}`);
        }
        throw new Error('Bankrbot job completed but no transaction data returned');
      }

      if (status.status === 'failed') {
        throw new Error(`Bankrbot job failed: ${status.error || 'Unknown error'}`);
      }

      // Wait before next poll
      await this.delay(this.pollInterval);
      attempts++;
    }

    throw new Error(`Bankrbot job timed out after ${this.maxPollAttempts * this.pollInterval / 1000}s`);
  }

  /**
   * Get transaction with KaiSign clear signing info
   *
   * This method combines transaction generation with clear signing verification:
   * 1. Bankrbot builds transaction from natural language
   * 2. KaiSign validates the transaction and provides verified intent
   * 3. Returns both for user confirmation
   *
   * @param prompt Natural language transaction request
   * @param chainId Chain ID (default: Base 8453)
   * @param userAddress Optional user address
   * @returns Transaction with clear signing verification
   */
  async getTransactionWithClearSign(
    prompt: string,
    chainId: number = 8453,
    userAddress?: string
  ): Promise<{
    transaction: BankrTransactionResult;
    clearSign: ClearSignResult;
  }> {
    // Get transaction from Bankrbot
    const transaction = await this.getTransaction(prompt, chainId, userAddress);

    // Get clear signing info from KaiSign
    const clearSign = await getClearSignPrompt({
      to: transaction.to,
      data: transaction.data,
      chainId: transaction.chainId,
      value: transaction.value
    });

    return { transaction, clearSign };
  }

  private ensureConfigured(): void {
    if (!this.apiKey) {
      throw new Error('BANKR_API_KEY environment variable not set');
    }
  }

  private async parseError(response: Response): Promise<BankrError> {
    try {
      return await response.json() as BankrError;
    } catch {
      return {
        error: `HTTP ${response.status}: ${response.statusText}`
      };
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const bankrbotClient = new BankrbotClient();
