import { Module } from '@nestjs/common';
import { TripsModule } from '../trips/trips.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  imports: [TripsModule, WhatsappModule],
  controllers: [CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
