import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RewardEvaluationService } from './reward-evaluation.service.js';
import { CouponsService } from './coupons.service.js';
import { CouponsController } from './coupons.controller.js';

@Module({
  imports: [PrismaModule],
  controllers: [CouponsController],
  providers: [RewardEvaluationService, CouponsService],
  exports: [RewardEvaluationService],
})
export class RewardsModule {}
