require("dotenv").config();
const express = require("express");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const stream = require("stream");
const AWS = require("aws-sdk");
const app = express();
const path = require("path"); // Import the path module
const fs = require("fs");
const uuid = require("uuid");

// Configure AWS S3
AWS.config.update({
  accessKeyId: process.env.aws_access_key_id,
  secretAccessKey: process.env.aws_secret_access_key,
  sessionToken: process.env.aws_session_token,
  region: "ap-southeast-2",
});

// Set S3 bucket
const s3 = new AWS.S3();
const s3BucketName = `cloudproject-group24`;

// Check for S3 Bucket
async function createS3bucket() {
  try {
    await s3.createBucket({ Bucket: s3BucketName }).promise();
    console.log(`Created bucket: ${s3BucketName}`);
  } catch (err) {
    if (err.statusCode === 409) {
      console.log(`Bucket successfully located: ${s3BucketName}`);
    } else {
      console.log(`Error creating bucket: ${err}`);
    }
  }
}

(async () => {
  await createS3bucket();
})();

// Configure multer to use memory storage
const upload = multer();

// Serve static files from the "public" directory
app.use(express.static("public"));

// Define routes
app.use(express.json());

// Function to Upload & Transcode
app.post("/upload", upload.single("videoFile"), (req, res) => {
  const format = req.body.format;
  const bitrate = req.body.bitrate;
  const resolution = req.body.resolution;

  let videoCodec;

  // Set videoCodec
  if (format === "mp4") {
    videoCodec = "libx264";
  } else if (format === "mov") {
    videoCodec = "libx264";
  } else if (format === "avi") {
    videoCodec = "libxvid";
  } else {
    videoCodec = "libx264";
  }

  console.log("1. File Uploading...");

  // Access the uploaded file from memory
  const uploadedFileBuffer = req.file.buffer;

  // Generate a unique identifier using uuid
  const uniqueIdentifier = uuid.v4();

  // Append the unique identifier to file name
  const originalFileName = req.file.originalname;
  const extname = path.extname(originalFileName);
  const baseName = path.basename(originalFileName, extname);
  const modifiedFileName = `${baseName}_${uniqueIdentifier}${extname}`;

  // Upload the original file to S3
  const originalFileParams = {
    Bucket: s3BucketName,
    Key: "uploads/" + modifiedFileName,
    Body: uploadedFileBuffer,
  };

  // Generate a pre-signed URL for the uploaded file
  const signedUrl = s3.getSignedUrl("getObject", {
    Bucket: s3BucketName,
    Key: "uploads/" + modifiedFileName,
  });

  console.log("2. File uploaded to AWS S3");

  s3.upload(originalFileParams, (err, originalFileData) => {
    if (err) {
      return res.status(500).send("Failed to upload the original file to S3");
    }

    const outVideoPath = path.join(
      "tmp/",
      `${path.basename(
        modifiedFileName,
        path.extname(modifiedFileName)
      )}.${format}`
    );
    const ffmpegPath = path.join(__dirname, "ffmpeg", "ffmpeg");

    console.log("Path to FFmpeg:", ffmpegPath);

    ffmpeg(signedUrl)
      .setFfmpegPath(ffmpegPath)
      .outputFormat(format)
      .videoCodec(videoCodec)
      .audioCodec("aac")
      .videoBitrate(bitrate)
      .size(resolution)
      .on("start", () => {
        console.log("3. Video loaded into ffmpeg");
      })
      .on("end", () => {
        console.log("4. Video transcoded");

        function bufferFile(relPath) {
          return fs.readFileSync(relPath);
        }

        const transcodedFolder = "transcodes/";
        const transcodedFileKey =
          transcodedFolder +
          `${path.basename(
            modifiedFileName,
            path.extname(modifiedFileName)
          )}.${format}`;

        // Upload the transcoded video to S3
        const transcodedFileParams = {
          Bucket: s3BucketName,
          Key: transcodedFileKey,
          Body: bufferFile(outVideoPath),
        };

        console.log("5. Transcoded video uploaded");

        s3.upload(transcodedFileParams, (err, transcodedFileData) => {
          if (err) {
            return res
              .status(500)
              .send("Failed to upload the transcoded video to S3");
          }
          // Provide download links to the user
          const downloadLink = s3.getSignedUrl("getObject", {
            Bucket: s3BucketName,
            Key: transcodedFileParams.Key,
          });

          res.json({
            message: "Transcoding complete",
            originalFileData,
            transcodedFileData,
            downloadLink,
          });
        });
        console.log("6. Process completed");

        try {
          // Synchronously delete the local video file in the "tmp" directory
          fs.unlinkSync(outVideoPath);
          console.log("Local video file deleted");
        } catch (err) {
          console.error("Error deleting local video file:", err);
        }
      })
      .on("error", (err) => {
        console.error("FFmpeg error:", err);
      })
      .save(outVideoPath);
  });
});

// Start the Express server
app.listen(3000, () => {
  console.log("Server started on port 3000");
});
