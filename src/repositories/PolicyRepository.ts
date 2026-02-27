import { prisma } from '../config/prisma.js';
import { Prisma } from '@prisma/client';

export interface ToolPolicySet {
  id: string;
  serverId: string | null;
  version: number;
  status: string;
  dsl: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

type ToolPolicySetDelegate = {
  findUnique(args: { where: { id: string } }): Promise<ToolPolicySet | null>;
  findFirst(args: {
    where: { serverId: string | null; status: string };
    orderBy: { version: 'asc' | 'desc' };
  }): Promise<ToolPolicySet | null>;
  findMany(args: {
    where: { status: string; serverId?: string | null };
    orderBy?: { version: 'asc' | 'desc' };
  }): Promise<ToolPolicySet[]>;
  create(args: {
    data: { serverId: string | null; dsl: Prisma.InputJsonValue | typeof Prisma.JsonNull; status: string };
  }): Promise<ToolPolicySet>;
  update(args: {
    where: { id: string };
    data: { dsl?: Prisma.InputJsonValue | typeof Prisma.JsonNull; status?: string };
  }): Promise<ToolPolicySet>;
  delete(args: { where: { id: string } }): Promise<ToolPolicySet>;
  updateMany(args: {
    where: { serverId: string | null; status: string };
    data: { status: string };
  }): Promise<{ count: number }>;
};

const toolPolicySetModel = prisma as unknown as { toolPolicySet: ToolPolicySetDelegate };

export class PolicyRepository {
  static async findById(id: string): Promise<ToolPolicySet | null> {
    return await toolPolicySetModel.toolPolicySet.findUnique({
      where: { id }
    });
  }

  static async findActiveByServerId(serverId: string | null): Promise<ToolPolicySet | null> {
    return await toolPolicySetModel.toolPolicySet.findFirst({
      where: {
        serverId,
        status: 'active'
      },
      orderBy: {
        version: 'desc'
      }
    });
  }

  static async findAllActive(): Promise<ToolPolicySet[]> {
    return await toolPolicySetModel.toolPolicySet.findMany({
      where: {
        status: 'active'
      }
    });
  }

  static async create(data: { serverId?: string | null; dsl: Prisma.JsonValue }): Promise<ToolPolicySet> {
    const dsl = data.dsl === null ? Prisma.JsonNull : (data.dsl as Prisma.InputJsonValue);

    return await toolPolicySetModel.toolPolicySet.create({
      data: {
        serverId: data.serverId ?? null,
        dsl,
        status: 'active'
      }
    });
  }

  static async update(id: string, data: { dsl?: Prisma.JsonValue; status?: string }): Promise<ToolPolicySet> {
    const updateData: { dsl?: Prisma.InputJsonValue | typeof Prisma.JsonNull; status?: string } = {};

    if (data.dsl !== undefined) {
      updateData.dsl = data.dsl === null ? Prisma.JsonNull : (data.dsl as Prisma.InputJsonValue);
    }

    if (data.status !== undefined) {
      updateData.status = data.status;
    }

    return await toolPolicySetModel.toolPolicySet.update({
      where: { id },
      data: updateData
    });
  }

  static async delete(id: string): Promise<ToolPolicySet> {
    return await toolPolicySetModel.toolPolicySet.delete({
      where: { id }
    });
  }

  static async getEffectivePolicy(serverId: string | null): Promise<ToolPolicySet[]> {
    const [serverSpecificPolicies, globalPolicies] = await Promise.all([
      serverId
        ? toolPolicySetModel.toolPolicySet.findMany({
            where: {
              status: 'active',
              serverId
            },
            orderBy: {
              version: 'desc'
            }
          })
        : Promise.resolve([]),
      toolPolicySetModel.toolPolicySet.findMany({
        where: {
          status: 'active',
          serverId: null
        },
        orderBy: {
          version: 'desc'
        }
      })
    ]);

    return [...serverSpecificPolicies, ...globalPolicies];
  }

  static async archiveByServerId(serverId: string | null): Promise<number> {
    const result = await toolPolicySetModel.toolPolicySet.updateMany({
      where: {
        serverId,
        status: 'active'
      },
      data: {
        status: 'archived'
      }
    });

    return result.count;
  }
}

export default PolicyRepository;
