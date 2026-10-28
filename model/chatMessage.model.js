import mongoose from "mongoose";

const chatMessageSchema = new mongoose.Schema(
  {
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],
     text: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
      // Text tab lazmi hy jab attachment na ho
      required: function () {
        return !this.attachment || !this.attachment.url;
      },
    },
    attachment: {
      url: { type: String, default: null },
      type: { type: String, enum: ["image", "file"], default: "file" },
      name: { type: String, default: "" },
      mimeType: { type: String, default: "" },
      size: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

chatMessageSchema.index({ booking: 1, createdAt: 1 });

export const ChatMessage = mongoose.model("ChatMessage", chatMessageSchema);
