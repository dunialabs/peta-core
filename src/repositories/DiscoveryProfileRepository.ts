import { prisma } from '../config/prisma.js';
import { Prisma } from '@prisma/client';

export interface DiscoveryProfileRecord {
  id: string;
  name: string;
  description: string | null;
  mode: string;
  enabled: boolean;
  isDefault: boolean;
  publicVisible: boolean;
  anonymousVisible: boolean;
  config: Prisma.JsonValue | null;
  instructionText: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type DiscoveryProfileDelegate = {
  findMany(args?: { orderBy?: { createdAt: 'asc' | 'desc' } }): Promise<DiscoveryProfileRecord[]>;
  findUnique(args: {
    where: { id?: string; name?: string };
  }): Promise<DiscoveryProfileRecord | null>;
  findFirst(args: {
    where?: Partial<{
      enabled: boolean;
      isDefault: boolean;
    }>;
    orderBy?: { updatedAt: 'asc' | 'desc' };
  }): Promise<DiscoveryProfileRecord | null>;
  create(args: {
    data: {
      name: string;
      description?: string | null;
      mode?: string;
      enabled?: boolean;
      isDefault?: boolean;
      publicVisible?: boolean;
      anonymousVisible?: boolean;
      config?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
      instructionText?: string | null;
    };
  }): Promise<DiscoveryProfileRecord>;
  update(args: {
    where: { id: string };
    data: {
      name?: string;
      description?: string | null;
      mode?: string;
      enabled?: boolean;
      isDefault?: boolean;
      publicVisible?: boolean;
      anonymousVisible?: boolean;
      config?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
      instructionText?: string | null;
    };
  }): Promise<DiscoveryProfileRecord>;
  updateMany(args: {
    where: Partial<{ isDefault: boolean }>;
    data: { isDefault: boolean };
  }): Promise<{ count: number }>;
  delete(args: { where: { id: string } }): Promise<DiscoveryProfileRecord>;
};

const discoveryProfileModel = prisma as unknown as {
  discoveryProfile: DiscoveryProfileDelegate;
};

type DiscoveryProfileCreateData = {
  name: string;
  description?: string;
  mode?: string;
  enabled?: boolean;
  isDefault?: boolean;
  publicVisible?: boolean;
  anonymousVisible?: boolean;
  config?: Prisma.JsonValue;
  instructionText?: string;
};

type DiscoveryProfileUpdateData = {
  name?: string;
  description?: string;
  mode?: string;
  enabled?: boolean;
  isDefault?: boolean;
  publicVisible?: boolean;
  anonymousVisible?: boolean;
  config?: Prisma.JsonValue;
  instructionText?: string;
};

export class DiscoveryProfileRepository {
  static async findAll(): Promise<DiscoveryProfileRecord[]> {
    return await discoveryProfileModel.discoveryProfile.findMany({
      orderBy: { createdAt: 'asc' },
    });
  }

  static async findById(id: string): Promise<DiscoveryProfileRecord | null> {
    return await discoveryProfileModel.discoveryProfile.findUnique({
      where: { id },
    });
  }

  static async findDefault(): Promise<DiscoveryProfileRecord | null> {
    return await discoveryProfileModel.discoveryProfile.findFirst({
      where: { isDefault: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  static async create(data: DiscoveryProfileCreateData): Promise<DiscoveryProfileRecord> {
    return await discoveryProfileModel.discoveryProfile.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        mode: data.mode,
        enabled: data.enabled,
        isDefault: data.isDefault,
        publicVisible: data.publicVisible,
        anonymousVisible: data.anonymousVisible,
        config:
          data.config === undefined
            ? undefined
            : data.config === null
              ? Prisma.JsonNull
              : (data.config as Prisma.InputJsonValue),
        instructionText: data.instructionText ?? null,
      },
    });
  }

  static async update(
    id: string,
    data: DiscoveryProfileUpdateData,
  ): Promise<DiscoveryProfileRecord> {
    return await discoveryProfileModel.discoveryProfile.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description === undefined ? undefined : (data.description ?? null),
        mode: data.mode,
        enabled: data.enabled,
        isDefault: data.isDefault,
        publicVisible: data.publicVisible,
        anonymousVisible: data.anonymousVisible,
        config:
          data.config === undefined
            ? undefined
            : data.config === null
              ? Prisma.JsonNull
              : (data.config as Prisma.InputJsonValue),
        instructionText:
          data.instructionText === undefined ? undefined : (data.instructionText ?? null),
      },
    });
  }

  static async delete(id: string): Promise<DiscoveryProfileRecord> {
    return await discoveryProfileModel.discoveryProfile.delete({
      where: { id },
    });
  }

  static async setDefault(id: string): Promise<DiscoveryProfileRecord> {
    await prisma.$transaction(async (tx) => {
      const txModel = tx as unknown as {
        discoveryProfile: DiscoveryProfileDelegate;
      };

      await txModel.discoveryProfile.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });

      await txModel.discoveryProfile.update({
        where: { id },
        data: { isDefault: true },
      });
    });

    const updated = await this.findById(id);
    if (!updated) {
      throw new Error(`Discovery profile not found after setDefault: ${id}`);
    }
    return updated;
  }
}

export default DiscoveryProfileRepository;
