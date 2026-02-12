import { AuthError, AuthErrorType } from '../types/auth.types.js';
import { webcrypto } from 'node:crypto';

export interface EncryptedData {
  data: string // Base64 encoded encrypted data
  iv: string // Base64 encoded initialization vector
  salt: string // Base64 encoded salt
  tag: string // Base64 encoded authentication tag
}

/**
 * Encryption and decryption service
 * Integrates AES-GCM encryption and decryption implementation
 */
export class CryptoService {
  /**
   * Calculate MD5 hash of token as user ID
   */
  static async calculateUserId(token: string): Promise<string> {
    const hash = await this.hash(token);
    return hash.substring(0, 32);
  }

  static async hash(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);

    // Use SHA-256 instead of MD5 (more secure)
    const hashBuffer = await webcrypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    
    // Take first 32 characters to simulate MD5 length, or adjust as needed
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  }

  private static readonly PBKDF2_ITERATIONS = 100000
  private static readonly KEY_LENGTH = 256 // 256 bits for AES-256
  private static readonly IV_LENGTH = 96; // 96 bits for GCM
  private static readonly SALT_LENGTH = 128; // 128 bits for random salts

  /**
    * Derive key from password using PBKDF2
    * @param password - The password to derive key from
    * @param salt - Salt for key derivation
    * @param iterations - Number of PBKDF2 iterations
    * @param extractable - Whether the key can be exported using exportKey(). 
    *                      Set to true only when you need to export the key (e.g., for hashing).
    *                      Defaults to false for better security.
    */
  static async deriveKey(
    password: string,
    salt: Uint8Array,
    iterations: number = this.PBKDF2_ITERATIONS,
    extractable: boolean = false
  ): Promise<CryptoKey> {
    const encoder = new TextEncoder()
    const passwordBuffer = encoder.encode(password)

    const baseKey = await webcrypto.subtle.importKey(
      'raw',
      passwordBuffer,
      'PBKDF2',
      false,
      ['deriveKey']
    )

    return webcrypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt as BufferSource,
        iterations: iterations,
        hash: 'SHA-256',
      },
      baseKey,
      {
        name: 'AES-GCM',
        length: this.KEY_LENGTH,
      },
      extractable,
      ['encrypt', 'decrypt']
    )
  }

  /**
   * Decrypt data using AES-GCM
   */
  static async decrypt(encryptedData: EncryptedData, key: CryptoKey): Promise<string> {
    const data = new Uint8Array(atob(encryptedData.data).split('').map((c) => c.charCodeAt(0)))
    const iv = new Uint8Array(atob(encryptedData.iv).split('').map((c) => c.charCodeAt(0)))
    const tag = new Uint8Array(atob(encryptedData.tag).split('').map((c) => c.charCodeAt(0)))

    // Combine encrypted data and tag for decryption
    const combinedBuffer = new Uint8Array(data.length + tag.length)
    combinedBuffer.set(data)
    combinedBuffer.set(tag, data.length)

    const decryptedBuffer = await webcrypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
      },
      key,
      combinedBuffer
    )

    const decoder = new TextDecoder()
    return decoder.decode(decryptedBuffer)
  }


  /**
   * Encrypt data using AES-GCM
   */
  static async encrypt(
    data: string,
    key: CryptoKey,
    salt?: Uint8Array,
  ): Promise<EncryptedData> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);

    const iv = this.generateIV();
    const usedSalt = salt || this.generateSalt();

    const encryptedBuffer = await this.getCrypto().subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
      },
      key,
      dataBuffer,
    );

    // Extract the encrypted data and authentication tag
    const encryptedArray = new Uint8Array(encryptedBuffer);
    const encryptedData = encryptedArray.slice(0, -16); // All but last 16 bytes
    const tag = encryptedArray.slice(-16); // Last 16 bytes are the tag

    return {
      data: btoa(String.fromCharCode.apply(null, Array.from(encryptedData))),
      iv: btoa(String.fromCharCode.apply(null, Array.from(iv))),
      salt: btoa(String.fromCharCode.apply(null, Array.from(usedSalt))),
      tag: btoa(String.fromCharCode.apply(null, Array.from(tag))),
    };
  }

  /**
   * Decrypt data using key
   */
  static async decryptData(encryptedData: EncryptedData, key: string): Promise<string> {
    const salt = new Uint8Array(atob(encryptedData.salt).split('').map((c) => c.charCodeAt(0)))
    const cryptoKey = await this.deriveKey(key, salt)

    return this.decrypt(encryptedData, cryptoKey)
  }


  /**
   * Decrypt data from string using key
   * @param encryptedDataString - JSON stringified EncryptedData object
   * @param key - The key to decrypt with
   * @returns Decrypted string data
   */
  static async decryptDataFromString(encryptedDataString: string, key: string): Promise<string> {
    try {
      // Validate input parameters
      if (!encryptedDataString || typeof encryptedDataString !== 'string') {
        throw new Error('Invalid encrypted data string: must be a non-empty string');
      }

      if (!key || typeof key !== 'string') {
        throw new Error('Invalid decryption key: must be a non-empty string');
      }

      // Parse the JSON string back to EncryptedData object
      let encryptedData: EncryptedData;
      try {
        encryptedData = JSON.parse(encryptedDataString);
      } catch (parseError) {
        throw new Error('Invalid JSON format in encrypted data string');
      }

      // Validate the parsed object has required fields
      if (!encryptedData || typeof encryptedData !== 'object') {
        throw new Error('Parsed data must be an object');
      }

      if (!encryptedData.data || !encryptedData.iv || !encryptedData.salt || !encryptedData.tag) {
        throw new Error('Missing required fields in encrypted data object');
      }

      // Use the existing decryptData method
      return await this.decryptData(encryptedData, key);

    } catch (error) {
      // Handle specific error types
      if (error instanceof Error) {
        // Re-throw our custom validation errors
        if (error.message.startsWith('Invalid') || 
            error.message.startsWith('Missing') || 
            error.message.startsWith('Parsed')) {
          throw error;
        }
        
        // Handle base64 decoding errors from decryptData
        if (error.name === 'InvalidCharacterError') {
          throw new Error('Invalid base64 encoding in encrypted data');
        }
        
        // Handle cryptographic errors from decrypt operation
        if (error.name === 'OperationError' || 
            error.message.includes('decrypt')) {
          throw new Error('Decryption failed: invalid key or corrupted data');
        }
        
        // Handle key derivation errors
        if (error.message.includes('deriveKey') || 
            error.message.includes('PBKDF2')) {
          throw new Error('Key derivation failed: invalid password or salt');
        }
      }
      
      // Generic error for unexpected cases
      throw new Error('Failed to decrypt data from string: ' + (error instanceof Error ? error.message : 'unknown error'));
    }
  }


  /**
   * Get crypto instance (works in both browser and Node.js)
   */
  private static getCrypto(): Crypto {
    if (typeof window !== 'undefined') {
      // Browser environment
      if (!window.crypto || !window.crypto.subtle) {
        throw new Error(
          'Web Crypto API is not available. This application requires HTTPS or localhost. ' +
          'Please access via HTTPS (https://...) or localhost (http://localhost:...).'
        );
      }
      return window.crypto;
    }
    // Node.js environment - import crypto dynamically
    if (typeof globalThis !== 'undefined' && (globalThis as any).crypto) {
      return (globalThis as any).crypto;
    }
    throw new Error('Crypto API not available');
  }

  /**
   * Generate a random salt
   */
  static generateSalt(): Uint8Array {
    return this.getCrypto().getRandomValues(new Uint8Array(this.SALT_LENGTH / 8));
  }

  /**
   * Generate a random initialization vector
   */
  static generateIV(): Uint8Array {
    return this.getCrypto().getRandomValues(new Uint8Array(this.IV_LENGTH / 8));
  }

  /**
   * Encrypt data using key
   */
  static async encryptData(
    originalData: string,
    key: string,
  ): Promise<EncryptedData> {
    const salt = this.generateSalt();
    const tokenKey = await this.deriveKey(key, salt);
    return this.encrypt(originalData, tokenKey, salt);
  }
}